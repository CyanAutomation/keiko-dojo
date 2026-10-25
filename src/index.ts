import { D1SessionRepository } from './storage/d1-session-repository';
import { SessionService } from './application/session-service';
import { dispatchGitHubSessionSync, dispatchPendingGitHubSessionSyncs } from './application/github-session-sync-queue';
import { handleSessionsRequest } from './http/sessions';
import { jsonError, jsonResponse } from './http/responses';
import { authenticateRequest, AuthFailure } from './auth/bearer-auth';
import { authFailureResponse } from './http/auth-errors';
import { handleBackupRequest } from './http/backups';
import { processGitHubSessionSyncMessage } from './http/github-sync';
import { handleGitHubOperationRequest, processGitHubOperationMessage } from './http/github-operations';
import { handleMcpRequest } from './http/mcp';

function normalizedPath(pathname: string): string {
  return pathname.replace(/^\/v1\/sessions\/[^/]+$/, '/v1/sessions/:id');
}

async function handleRequest(
  request: Request,
  env: Env,
  requestId: string,
  ctx?: ExecutionContext
): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === '/healthz') return handleHealthCheck(request, requestId);
  if (url.pathname === '/readyz') return handleReadinessCheck(request, env, requestId);
  if (url.pathname === '/v1/analytics/summary') {
    return handleAnalyticsSummary(request, env, requestId);
  }
  if (url.pathname.startsWith('/v1/github/')) {
    return handleGitHubOperationRequest(request, env, requestId);
  }
  if (url.pathname.startsWith('/v1/backups')) {
    return handleBackupRequest(request, env, requestId);
  }

  const service = new SessionService(new D1SessionRepository(env.DB, (userId) => {
    const dispatch = dispatchGitHubSessionSync(env, userId);
    if (ctx) {
      ctx.waitUntil(dispatch.catch(() => {
        console.error('github_session_sync_dispatch_failed');
      }));
      return;
    }
    return dispatch;
  }));
  if (url.pathname === '/mcp') {
    return handleMcpRequest(request, env, requestId, service);
  }
  return handleSessionsRequest(request, service, env, requestId);
}

function handleHealthCheck(request: Request, requestId: string): Response {
  if (request.method === 'GET') return jsonResponse({ status: 'ok' });
  return jsonError(requestId, 405, 'method_not_allowed', 'Method not allowed', {
    Allow: 'GET',
  });
}

async function handleReadinessCheck(
  request: Request,
  env: Env,
  requestId: string
): Promise<Response> {
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

async function handleAnalyticsSummary(
  request: Request,
  env: Env,
  requestId: string
): Promise<Response> {
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
    if (error instanceof AuthFailure) return authFailureResponse(error, requestId);
    const errorName = error instanceof Error ? error.name : 'UnknownError';
    console.error({ event: 'analytics_summary_failed', requestId, errorName });
    return jsonError(requestId, 500, 'internal_error', 'An unexpected error occurred');
  }
}

const worker = {
  async fetch(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
    const requestId = crypto.randomUUID();
    const startedAt = Date.now();
    const url = new URL(request.url);
    let response: Response;

    try {
      response = await handleRequest(request, env, requestId, ctx);
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
        'kind' in value && value.kind === 'github-session-sync' &&
        'userId' in value && typeof value.userId === 'string'
      ) {
        await processGitHubSessionSyncMessage(
          message as Message<{ kind: 'github-session-sync'; userId: string; operationId?: string }>,
          env
        );
        continue;
      }
      if (
        value && typeof value === 'object' &&
        'kind' in value && value.kind === 'github-operation' &&
        'jobId' in value && typeof value.jobId === 'string' &&
        'userId' in value && typeof value.userId === 'string'
      ) {
        await processGitHubOperationMessage(
          message as Message<{ kind: 'github-operation'; jobId: string; userId: string }>,
          env
        );
        continue;
      }
      message.ack();
    }
  },
  async scheduled(_controller: ScheduledController, env: Env) {
    await dispatchPendingGitHubSessionSyncs(env);
  },
} satisfies ExportedHandler<Env>;

export default worker;
