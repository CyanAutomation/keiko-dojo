import { authenticateRequest, AuthFailure } from '../auth/bearer-auth';
import {
  isJsonObject,
  isSessionCategory,
  validateSessionId,
} from '../domain/session';
import {
  InvalidSessionCursorError,
  SessionAlreadyExistsError,
  InvalidSessionError,
  SessionNotFoundError,
  SessionRevisionConflictError,
  SessionService,
} from '../application/session-service';
import type { SessionRecord } from '../domain/session';
import { authFailureResponse } from './auth-errors';
import { jsonError, jsonResponse } from './responses';

const MAX_BODY_BYTES = 64 * 1024;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

type BodyResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; status: 400 | 413 | 415 };

async function readJsonObject(request: Request): Promise<BodyResult> {
  const contentType = request.headers
    .get('content-type')
    ?.split(';', 1)[0]
    .trim()
    .toLowerCase();
  if (contentType !== 'application/json') return { ok: false, status: 415 };

  const contentLength = request.headers.get('content-length');
  if (contentLength && Number(contentLength) > MAX_BODY_BYTES) {
    return { ok: false, status: 413 };
  }
  if (!request.body) return { ok: false, status: 400 };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > MAX_BODY_BYTES) {
        await reader.cancel();
        return { ok: false, status: 413 };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, status: 400 };
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return { ok: false, status: 400 };
  }
  return isJsonObject(parsed)
    ? { ok: true, value: parsed }
    : { ok: false, status: 400 };
}

function bodyFailureResponse(status: 400 | 413 | 415, requestId: string): Response {
  if (status === 413) {
    return jsonError(
      requestId,
      413,
      'payload_too_large',
      'Request body exceeds the 64 KiB limit'
    );
  }
  if (status === 415) {
    return jsonError(
      requestId,
      415,
      'unsupported_media_type',
      'Content-Type must be application/json'
    );
  }
  return jsonError(requestId, 400, 'bad_request', 'Invalid request body');
}

function isValidDate(value: string): boolean {
  if (!ISO_DATE_PATTERN.test(value)) return false;
  const [yearText, monthText, dayText] = value.split('-');
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function parsePageSize(value: string | null): number | null {
  if (value === null) return DEFAULT_PAGE_SIZE;
  if (!/^[1-9]\d*$/.test(value)) return null;
  const size = Number(value);
  return Number.isSafeInteger(size) && size <= MAX_PAGE_SIZE ? size : null;
}

function readListFilters(url: URL) {
  const limit = parsePageSize(url.searchParams.get('limit'));
  if (limit === null) return null;

  const from = url.searchParams.get('from') ?? undefined;
  const to = url.searchParams.get('to') ?? undefined;
  if ((from && !isValidDate(from)) || (to && !isValidDate(to))) return null;
  if (from && to && from > to) return null;

  const category = url.searchParams.get('category') ?? undefined;
  if (category && !isSessionCategory(category)) return null;

  const rawEffort = url.searchParams.get('effort');
  let effort: number | undefined;
  if (rawEffort !== null) {
    if (!/^[1-5]$/.test(rawEffort)) return null;
    effort = Number(rawEffort);
  }

  const cursor = url.searchParams.get('cursor') ?? undefined;
  if (cursor && cursor.length > 512) return null;
  return { limit, from, to, category, effort, cursor };
}

async function parseExpectedRevision(request: Request, userId: string): Promise<
  | { ok: true; revision: number }
  | { ok: false; status: 400 | 428 }> {
  const ifMatch = request.headers.get('if-match');
  if (!ifMatch) return { ok: false, status: 428 };
  const match = ifMatch.match(/^"([1-9]\d*)(?:-([a-f0-9]{24}))?"$/);
  if (!match) return { ok: false, status: 400 };
  if (match[2] && match[2] !== await userTag(userId)) return { ok: false, status: 400 };
  const revision = Number(match[1]);
  return Number.isSafeInteger(revision)
    ? { ok: true, revision }
    : { ok: false, status: 400 };
}

function revisionFailureResponse(
  requestId: string,
  status: 400 | 428
): Response {
  return status === 428
    ? jsonError(
        requestId,
        428,
        'precondition_required',
        'If-Match is required'
      )
    : jsonError(requestId, 400, 'bad_request', 'Invalid If-Match header');
}

function sessionIdFromPath(pathname: string):
  | { ok: true; id: string }
  | { ok: false; error: string } {
  const encodedId = pathname.slice('/v1/sessions/'.length);
  let value: string;
  try {
    value = decodeURIComponent(encodedId);
  } catch {
    return { ok: false, error: 'Invalid session ID' };
  }
  const validation = validateSessionId(value, false);
  return validation.ok
    ? { ok: true, id: validation.value }
    : { ok: false, error: validation.error };
}

async function userTag(userId: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(userId));
  return [...new Uint8Array(digest).slice(0, 12)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function sessionEtag(userId: string, revision: number): Promise<string> {
  return `"${revision}-${await userTag(userId)}"`;
}

function matchesIfNoneMatch(value: string | null, etag: string): boolean {
  return value?.split(',').some((candidate) => {
    const tag = candidate.trim();
    return tag === '*' || tag.replace(/^W\//, '') === etag;
  }) ?? false;
}

async function recordResponse(
  record: SessionRecord,
  userId: string,
  status = 200,
  revalidatable = false
): Promise<Response> {
  const headers = new Headers({ ETag: await sessionEtag(userId, record.revision) });
  if (revalidatable) {
    headers.set('Cache-Control', 'private, no-cache');
    headers.set('Vary', 'Authorization');
    return Response.json({ data: record }, { status, headers });
  }
  return jsonResponse({ data: record }, status, headers);
}

async function listSessions(
  url: URL,
  userId: string,
  service: SessionService,
  requestId: string
): Promise<Response> {
  const filters = readListFilters(url);
  if (!filters) return jsonError(requestId, 400, 'bad_request', 'Invalid list filters');
  try {
    const page = await service.list(userId, filters);
    return jsonResponse({
      data: page.records,
      pagination: {
        nextCursor: page.nextCursor,
        hasMore: page.nextCursor !== null,
      },
    });
  } catch (error) {
    if (error instanceof InvalidSessionCursorError) {
      return jsonError(requestId, 400, 'bad_request', error.message);
    }
    throw error;
  }
}

async function createSession(
  request: Request,
  userId: string,
  service: SessionService,
  requestId: string
): Promise<Response> {
  const body = await readJsonObject(request);
  if (!body.ok) return bodyFailureResponse(body.status, requestId);
  try {
    return recordResponse(await service.create(userId, body.value), userId, 201);
  } catch (error) {
    if (error instanceof SessionAlreadyExistsError) {
      return jsonError(requestId, 409, 'session_conflict', 'Session ID already exists');
    }
    if (error instanceof InvalidSessionError) {
      return jsonError(requestId, 400, error.code, error.message);
    }
    throw error;
  }
}

async function handleCollectionRequest(
  request: Request,
  url: URL,
  userId: string,
  service: SessionService,
  requestId: string
): Promise<Response> {
  return request.method.toUpperCase() === 'GET'
    ? listSessions(url, userId, service, requestId)
    : createSession(request, userId, service, requestId);
}

async function getSession(
  request: Request,
  userId: string,
  id: string,
  service: SessionService,
  requestId: string
): Promise<Response> {
  const record = await service.get(userId, id);
  if (!record) return jsonError(requestId, 404, 'not_found', 'Session not found');
  const etag = await sessionEtag(userId, record.revision);
  if (matchesIfNoneMatch(request.headers.get('if-none-match'), etag)) {
    return new Response(null, {
      status: 304,
      headers: { ETag: etag, 'Cache-Control': 'private, no-cache', Vary: 'Authorization' },
    });
  }
  return recordResponse(record, userId, 200, true);
}

async function updateSession(
  request: Request,
  userId: string,
  id: string,
  service: SessionService,
  revision: number,
  requestId: string
): Promise<Response> {
  const body = await readJsonObject(request);
  if (!body.ok) return bodyFailureResponse(body.status, requestId);
  try {
    return recordResponse(await service.update(userId, id, body.value, revision), userId);
  } catch (error) {
    if (error instanceof InvalidSessionError) {
      return jsonError(requestId, 400, error.code, error.message);
    }
    if (error instanceof SessionNotFoundError) {
      return jsonError(requestId, 404, 'not_found', 'Session not found');
    }
    if (error instanceof SessionRevisionConflictError) {
      return jsonError(
        requestId,
        412,
        'revision_conflict',
        'Session has changed; retrieve the latest revision and retry'
      );
    }
    throw error;
  }
}

async function deleteSession(
  userId: string,
  id: string,
  service: SessionService,
  revision: number,
  requestId: string
): Promise<Response> {
  try {
    await service.delete(userId, id, revision);
    return new Response(null, {
      status: 204,
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    if (error instanceof SessionNotFoundError) {
      return jsonError(requestId, 404, 'not_found', 'Session not found');
    }
    if (error instanceof SessionRevisionConflictError) {
      return jsonError(
        requestId,
        412,
        'revision_conflict',
        'Session has changed; retrieve the latest revision and retry'
      );
    }
    throw error;
  }
}

async function handleItemRequest(
  request: Request,
  url: URL,
  userId: string,
  service: SessionService,
  requestId: string
): Promise<Response> {
  const parsedId = sessionIdFromPath(url.pathname);
  if (!parsedId.ok) {
    return jsonError(requestId, 400, 'bad_request', parsedId.error);
  }
  if (request.method.toUpperCase() === 'GET') {
    return getSession(request, userId, parsedId.id, service, requestId);
  }
  const expectedRevision = await parseExpectedRevision(request, userId);
  if (!expectedRevision.ok) {
    return revisionFailureResponse(requestId, expectedRevision.status);
  }
  return request.method.toUpperCase() === 'PUT'
    ? updateSession(request, userId, parsedId.id, service, expectedRevision.revision, requestId)
    : deleteSession(userId, parsedId.id, service, expectedRevision.revision, requestId);
}

export async function handleSessionsRequest(
  request: Request,
  service: SessionService,
  env: Env,
  requestId: string
): Promise<Response> {
  const url = new URL(request.url);
  const isCollection = url.pathname === '/v1/sessions';
  const isItem = url.pathname.startsWith('/v1/sessions/');
  if (!isCollection && !isItem) {
    return jsonError(requestId, 404, 'not_found', 'Route not found');
  }

  const method = request.method.toUpperCase();
  const allowed = isCollection ? ['GET', 'POST'] : ['GET', 'PUT', 'DELETE'];
  if (!allowed.includes(method)) {
    return jsonError(requestId, 405, 'method_not_allowed', 'Method not allowed', {
      Allow: isCollection ? 'GET, POST' : 'GET, PUT, DELETE',
    });
  }

  try {
    const scope = method === 'GET' ? 'sessions:read' : 'sessions:write';
    const { userId } = await authenticateRequest(request, env, scope);
    return isCollection
      ? handleCollectionRequest(request, url, userId, service, requestId)
      : handleItemRequest(request, url, userId, service, requestId);
  } catch (error) {
    if (error instanceof AuthFailure) return authFailureResponse(error, requestId);
    throw error;
  }
}
