export type ApiErrorCode =
  | 'bad_request'
  | 'invalid_session'
  | 'authentication_required'
  | 'insufficient_scope'
  | 'authentication_unavailable'
  | 'rate_limited'
  | 'not_found'
  | 'session_conflict'
  | 'revision_conflict'
  | 'precondition_required'
  | 'payload_too_large'
  | 'unsupported_media_type'
  | 'method_not_allowed'
  | 'internal_error';

export function jsonError(
  requestId: string,
  status: number,
  code: ApiErrorCode,
  message: string,
  headers?: HeadersInit
): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set('Cache-Control', 'no-store');
  return Response.json(
    { error: { code, message }, requestId },
    { status, headers: responseHeaders }
  );
}

export function jsonResponse(
  value: unknown,
  status = 200,
  headers?: HeadersInit
): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set('Cache-Control', 'no-store');
  return Response.json(value, { status, headers: responseHeaders });
}
