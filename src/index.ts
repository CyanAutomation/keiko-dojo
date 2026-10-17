import { D1SessionRepository } from './storage/d1-session-repository';
import { SessionService } from './application/session-service';
import { handleSessionsRequest } from './http/sessions';
import { jsonError, jsonResponse } from './http/responses';
import { authenticateRequest, AuthFailure } from './auth/bearer-auth';
import { handleBackupRequest, processBackupMessage } from './http/backups';
import { handleMcpRequest } from './http/mcp';

function normalizedPath(pathname: string): string {
  return pathname.replace(/^\/v1\/sessions\/[^/]+$/, '/v1/sessions/:id');
}

async function handleRequest(
  request: Request,
  env: Env,
  requestId: string
): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === '/healthz') {
    return request.method === 'GET'
      ? jsonResponse({ status: 'ok' })
      : jsonError(requestId, 405, 'method_not_allowed', 'Method not allowed', {
          Allow: 'GET',
        });
  }

  if (url.pathname === '/readyz') {
    if (request.method !== 'GET') {
      return jsonError(requestId, 405, 'method_not_allowed', 'Method not allowed', {
        Allow: 'GET',
      });
    }
    if (!env.AUTH_JWKS_URL || !env.AUTH_ISSUER || !env.AUTH_AUDIENCE) {
      return jsonError(
        requestId,
        503,
        'authentication_unavailable',
        'Service is not ready'
      );
    }
    try {
      await env.DB.prepare('SELECT 1 AS ready').first();
      return jsonResponse({ status: 'ready' });
    } catch {
      return jsonError(
        requestId,
        503,
        'internal_error',
        'Service is not ready'
      );
    }
  }

  if (url.pathname === '/v1/analytics/summary') {
    if (request.method !== 'GET') {
      return jsonError(requestId, 405, 'method_not_allowed', 'Method not allowed', {
        Allow: 'GET',
      });
    }
    try {
      const principal = await authenticateRequest(request, env, 'sessions:read');
      const service = new SessionService(new D1SessionRepository(env.DB));
      return jsonResponse(await service.analytics(principal.userId));
    } catch (error) {
      if (error instanceof AuthFailure) {
        if (error.kind === 'rate_limited') {
          return jsonError(requestId, 429, 'rate_limited', error.message, { 'Retry-After': '60' });
        }
        const status = error.kind === 'forbidden' ? 403 : error.kind === 'unavailable' ? 503 : 401;
        const code = error.kind === 'forbidden' ? 'insufficient_scope' : error.kind === 'unavailable' ? 'authentication_unavailable' : 'authentication_required';
        return jsonError(requestId, status, code, error.message);
      }
      console.error({ event: 'analytics_summary_failed', requestId, errorName: error instanceof Error ? error.name : 'UnknownError' });
      return jsonError(requestId, 500, 'internal_error', 'An unexpected error occurred');
    }
  }

  if (url.pathname.startsWith('/v1/backups')) {
    return handleBackupRequest(request, env, requestId);
  }

  if (url.pathname === '/mcp') {
    const service = new SessionService(new D1SessionRepository(env.DB));
    return handleMcpRequest(request, env, requestId, service);
  }

  const service = new SessionService(new D1SessionRepository(env.DB));
  return handleSessionsRequest(request, service, env, requestId);
}

const worker = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const requestId = crypto.randomUUID();
    const startedAt = Date.now();
    const url = new URL(request.url);
    let response: Response;

    try {
      response = await handleRequest(request, env, requestId);
    } catch (error) {
      const errorName = error instanceof Error ? error.name : 'UnknownError';
      console.error({ event: 'request_failed', requestId, errorName });
      response = jsonError(
        requestId,
        500,
        'internal_error',
        'An unexpected error occurred'
      );
    }

    console.log({
      event: 'http_request',
      requestId,
      environment: env.ENVIRONMENT,
      method: request.method,
      path: normalizedPath(url.pathname),
      status: response.status,
      durationMs: Date.now() - startedAt,
    });

    const headers = new Headers(response.headers);
    headers.set('X-Request-Id', requestId);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  },
  async queue(batch: MessageBatch<unknown>, env: Env) {
    for (const message of batch.messages) {
      const value = message.body;
      if (
        value && typeof value === 'object' &&
        'jobId' in value && typeof value.jobId === 'string' &&
        'userId' in value && typeof value.userId === 'string'
      ) {
        await processBackupMessage(
          message as Message<{ jobId: string; userId: string }>,
          env
        );
      } else {
        message.ack();
      }
    }
  },
  async scheduled(controller: ScheduledController, env: Env) {
    const installations = await env.DB.prepare(
      'SELECT user_id FROM github_installations WHERE revoked_at IS NULL'
    ).all<{ user_id: string }>();
    const requestedAt = new Date(controller.scheduledTime).toISOString();
    const scheduleKey = `${controller.cron}:${requestedAt}`;
    const dispatchAttemptedAt = new Date().toISOString();
    const staleDispatchCutoff = new Date(Date.now() - 60_000).toISOString();
    for (const { user_id: userId } of installations.results) {
      const id = crypto.randomUUID();
      const inserted = await env.DB.prepare(
        `INSERT OR IGNORE INTO backup_jobs
         (id, user_id, status, requested_at, schedule_key, dispatch_attempted_at)
         VALUES (?, ?, 'queued', ?, ?, ?)`
      ).bind(id, userId, requestedAt, scheduleKey, dispatchAttemptedAt).run();
      let jobId: string = id;
      let shouldQueue = inserted.meta.changes === 1;
      if (!shouldQueue) {
        const existing = await env.DB.prepare(
          `SELECT id FROM backup_jobs
           WHERE user_id = ? AND schedule_key = ? AND (
             (status = 'failed' AND error_code = 'queue_unavailable') OR
             (status = 'queued' AND dispatch_attempted_at <= ?)
           )`
        ).bind(userId, scheduleKey, staleDispatchCutoff).first<{ id: string }>();
        if (existing) {
          const retried = await env.DB.prepare(
            `UPDATE backup_jobs
             SET status = 'queued', error_code = NULL, dispatch_attempted_at = ?
             WHERE id = ? AND user_id = ? AND (
               (status = 'failed' AND error_code = 'queue_unavailable') OR
               (status = 'queued' AND dispatch_attempted_at <= ?)
             )`
          ).bind(dispatchAttemptedAt, existing.id, userId, staleDispatchCutoff).run();
          shouldQueue = retried.meta.changes === 1;
          jobId = existing.id;
        }
      }
      if (!shouldQueue) continue;
      try {
        await env.BACKUP_QUEUE.send({ jobId, userId });
      } catch {
        await env.DB.prepare(
          `UPDATE backup_jobs SET status = 'failed', error_code = 'queue_unavailable'
           WHERE id = ? AND user_id = ? AND status = 'queued'`
        ).bind(jobId, userId).run();
      }
    }
  },
} satisfies ExportedHandler<Env>;

export default worker;
