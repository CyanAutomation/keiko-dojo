import { D1SessionRepository } from './storage/d1-session-repository';
import { SessionService } from './application/session-service';
import { handleSessionsRequest } from './http/sessions';
import { jsonError, jsonResponse } from './http/responses';

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
} satisfies ExportedHandler<Env>;

export default worker;
