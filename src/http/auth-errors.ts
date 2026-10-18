import type { AuthFailure } from '../auth/bearer-auth';
import { jsonError } from './responses';

export function authFailureResponse(error: AuthFailure, requestId: string): Response {
  if (error.kind === 'rate_limited') {
    return jsonError(requestId, 429, 'rate_limited', error.message, {
      'Retry-After': '60',
    });
  }
  if (error.kind === 'forbidden') {
    return jsonError(requestId, 403, 'insufficient_scope', error.message);
  }
  if (error.kind === 'unavailable') {
    return jsonError(
      requestId,
      503,
      'authentication_unavailable',
      'Authentication service unavailable'
    );
  }
  return jsonError(
    requestId,
    401,
    'authentication_required',
    error.message,
    { 'WWW-Authenticate': 'Bearer' }
  );
}
