import { authenticateRequest, AuthFailure } from '../auth/bearer-auth';
import { isEffortLevel, isJsonObject, isSessionCategory, validateSessionPayload } from '../domain/session';
import { verifySelectedRepositoryInstallation, writeGitHubBackup } from '../integrations/github-app';
import { readJsonBodyLimited } from './request-body';
import { jsonError, jsonResponse } from './responses';

type BackupMessage = { jobId: string; userId: string };
export type SnapshotSession = {
  id: string;
  session_date: string;
  category: string;
  effort: number;
  payload: string;
  revision: number;
  updated_at: string;
};

function authError(error: AuthFailure, requestId: string): Response {
  if (error.kind === 'rate_limited') {
    return jsonError(requestId, 429, 'rate_limited', error.message, { 'Retry-After': '60' });
  }
  const status = error.kind === 'forbidden' ? 403 : error.kind === 'unavailable' ? 503 : 401;
  const code = error.kind === 'forbidden' ? 'insufficient_scope' : error.kind === 'unavailable' ? 'authentication_unavailable' : 'authentication_required';
  return jsonError(requestId, status, code, error.message);
}

type BodyObjectResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; reason: 'invalid' | 'too_large' };

async function bodyObject(request: Request): Promise<BodyObjectResult> {
  const parsed = await readJsonBodyLimited(request, 64 * 1024);
  if (!parsed.ok) return parsed;
  return isJsonObject(parsed.value)
    ? { ok: true, value: parsed.value }
    : { ok: false, reason: 'invalid' };
}

function bodyError(requestId: string, result: Extract<BodyObjectResult, { ok: false }>, message: string): Response {
  return result.reason === 'too_large'
    ? jsonError(requestId, 413, 'payload_too_large', 'Request body exceeds the 64 KiB limit')
    : jsonError(requestId, 400, 'bad_request', message);
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
}

function isCanonicalTimestamp(value: string): boolean {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return false;
  try {
    return new Date(timestamp).toISOString() === value;
  } catch {
    return false;
  }
}

async function hashState(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return hex(new Uint8Array(digest));
}

function frontendOrigin(env: Env): URL {
  const value = new URL(env.MATMETRICS_FRONTEND_URL);
  const localHttp = env.ENVIRONMENT === 'local' && value.protocol === 'http:' && value.hostname === 'localhost';
  if ((!localHttp && value.protocol !== 'https:') || value.origin !== env.MATMETRICS_FRONTEND_URL) {
    throw new Error('MatMetrics frontend origin is not configured');
  }
  return value;
}

function githubResultRedirect(env: Env, result: 'connected' | 'failed'): Response {
  const target = new URL(`/settings?githubBackup=${result}`, frontendOrigin(env));
  return new Response(null, {
    status: 302,
    headers: { Location: target.href, 'Cache-Control': 'no-store' },
  });
}

async function beginGitHubInstallation(request: Request, env: Env, requestId: string): Promise<Response> {
  const principal = await authenticateRequest(request, env, 'backups:write');
  const parsed = await bodyObject(request);
  if (!parsed.ok) return bodyError(requestId, parsed, 'Invalid installation request');
  const body = parsed.value;
  if (Object.keys(body).length !== 0) return jsonError(requestId, 400, 'bad_request', 'Invalid installation request');
  const installUrlText = env.GITHUB_APP_INSTALL_URL;
  let installUrl: URL;
  try { installUrl = new URL(installUrlText); } catch { return jsonError(requestId, 503, 'internal_error', 'GitHub App is not configured'); }
  if (
    installUrl.origin !== 'https://github.com' ||
    !/^\/apps\/[A-Za-z0-9-]+\/installations\/new$/.test(installUrl.pathname) ||
    installUrl.search || installUrl.hash || !env.GITHUB_APP_ID
  ) return jsonError(requestId, 503, 'internal_error', 'GitHub App is not configured');
  const state = crypto.randomUUID() + crypto.randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 10 * 60 * 1000);
  await env.DB.prepare(
    `INSERT INTO github_installation_states (state_hash, user_id, created_at, expires_at)
     VALUES (?, ?, ?, ?)`
  ).bind(await hashState(state), principal.userId, now.toISOString(), expiresAt.toISOString()).run();
  installUrl.searchParams.set('state', state);
  return jsonResponse({ url: installUrl.href, expiresAt: expiresAt.toISOString() }, 201);
}

async function completeGitHubInstallation(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const state = url.searchParams.get('state') ?? '';
  const installationIdText = url.searchParams.get('installation_id') ?? '';
  if (!/^[A-Za-z0-9-]{32,80}$/.test(state) || !/^[1-9]\d{0,15}$/.test(installationIdText)) {
    return githubResultRedirect(env, 'failed');
  }
  const installationId = Number(installationIdText);
  if (!Number.isSafeInteger(installationId)) return githubResultRedirect(env, 'failed');
  const stateHash = await hashState(state);
  const pending = await env.DB.prepare(
    `SELECT user_id FROM github_installation_states
     WHERE state_hash = ? AND consumed_at IS NULL AND expires_at > ?`
  ).bind(stateHash, new Date().toISOString()).first<{ user_id: string }>();
  if (!pending) return githubResultRedirect(env, 'failed');
  const consumedAt = new Date().toISOString();
  const consumed = await env.DB.prepare(
    `UPDATE github_installation_states SET consumed_at = ?
     WHERE state_hash = ? AND consumed_at IS NULL AND expires_at > ?`
  ).bind(consumedAt, stateHash, consumedAt).run();
  if (consumed.meta.changes !== 1) return githubResultRedirect(env, 'failed');

  try {
    const repository = await verifySelectedRepositoryInstallation(env, installationId);
    await env.DB.prepare(
      `INSERT INTO github_installations
       (user_id, installation_id, repository_owner, repository_name, repository_id, granted_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT(user_id) DO UPDATE SET
         installation_id = excluded.installation_id,
         repository_owner = excluded.repository_owner,
         repository_name = excluded.repository_name,
         repository_id = excluded.repository_id,
         granted_at = excluded.granted_at,
         revoked_at = NULL`
    ).bind(pending.user_id, repository.installation_id, repository.repository_owner,
      repository.repository_name, repository.repository_id, consumedAt).run();
    return githubResultRedirect(env, 'connected');
  } catch {
    return githubResultRedirect(env, 'failed');
  }
}

async function githubInstallationStatus(request: Request, env: Env): Promise<Response> {
  const principal = await authenticateRequest(request, env, 'backups:read');
  const record = await env.DB.prepare(
    `SELECT repository_owner AS owner, repository_name AS repository, repository_id AS repositoryId,
       granted_at AS grantedAt
     FROM github_installations WHERE user_id = ? AND revoked_at IS NULL`
  ).bind(principal.userId).first();
  return jsonResponse({ connected: Boolean(record), installation: record ?? null });
}

async function revokeGitHubInstallation(request: Request, env: Env): Promise<Response> {
  const principal = await authenticateRequest(request, env, 'backups:write');
  await env.DB.prepare(
    `UPDATE github_installations SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`
  ).bind(new Date().toISOString(), principal.userId).run();
  return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
}

async function status(request: Request, env: Env, requestId: string): Promise<Response> {
  const principal = await authenticateRequest(request, env, 'backups:read');
  const [latestJob, snapshots] = await Promise.all([
    env.DB.prepare(
      `SELECT id, status, requested_at AS requestedAt, completed_at AS completedAt, error_code AS errorCode
       FROM backup_jobs WHERE user_id = ? ORDER BY requested_at DESC LIMIT 1`
    ).bind(principal.userId).first(),
    env.DB.prepare(
      `SELECT id, created_at AS createdAt, session_count AS sessionCount, checksum
       FROM backup_snapshots WHERE user_id = ? ORDER BY created_at DESC LIMIT 20`
    ).bind(principal.userId).all(),
  ]);
  return jsonResponse({ latestJob: latestJob ?? null, snapshots: snapshots.results });
}

async function requestBackup(request: Request, env: Env, requestId: string): Promise<Response> {
  const principal = await authenticateRequest(request, env, 'backups:write');
  const parsed = await bodyObject(request);
  if (!parsed.ok) return bodyError(requestId, parsed, 'Invalid backup request');
  if (Object.keys(parsed.value).length !== 0) {
    return jsonError(requestId, 400, 'bad_request', 'Invalid backup request');
  }
  const id = crypto.randomUUID();
  const requestedAt = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO backup_jobs (id, user_id, status, requested_at)
     VALUES (?, ?, 'queued', ?)`
  ).bind(id, principal.userId, requestedAt).run();
  try {
    await env.BACKUP_QUEUE?.send({ jobId: id, userId: principal.userId } satisfies BackupMessage);
  } catch {
    await env.DB.prepare(
      `UPDATE backup_jobs SET status = 'failed', error_code = 'queue_unavailable' WHERE id = ? AND user_id = ?`
    ).bind(id, principal.userId).run();
    return jsonError(requestId, 503, 'internal_error', 'Backup queue is unavailable');
  }
  return jsonResponse({ id, status: 'queued', requestedAt }, 202);
}

async function previewRestore(
  userId: string,
  snapshotId: string,
  env: Env,
  requestId: string
): Promise<Response> {
  const snapshot = await env.DB.prepare(
    `SELECT id, created_at, session_count, checksum, payload FROM backup_snapshots WHERE id = ? AND user_id = ?`
  ).bind(snapshotId, userId).first<SnapshotRow>();
  if (!snapshot) return jsonError(requestId, 404, 'not_found', 'Backup not found');
  const snapshotRows = await validatedSnapshotRows(snapshot);
  if (!snapshotRows) return jsonError(requestId, 500, 'internal_error', 'Backup snapshot is invalid');
  const rows = await env.DB.prepare(
    'SELECT id, updated_at FROM sessions WHERE user_id = ?'
  ).bind(userId).all<{ id: string; updated_at: string }>();
  const snapshotIds = new Set(snapshotRows.map((row) => row.id));
  const preservedNewerCount = rows.results.filter((row) =>
    row.updated_at > snapshot.created_at || !snapshotIds.has(row.id)
  ).length;
  await env.DB.prepare(
    `INSERT INTO restore_activity (id, user_id, snapshot_id, action, created_at, preserved_newer_count)
     VALUES (?, ?, ?, 'previewed', ?, ?)`
  ).bind(crypto.randomUUID(), userId, snapshot.id, new Date().toISOString(), preservedNewerCount).run();
  return jsonResponse({
    snapshotId,
    createdAt: snapshot.created_at,
    sessionCount: snapshot.session_count,
    currentSessionCount: rows.results.length,
    preservedNewerCount,
    applyMode: 'merge-preserving-newer-data',
  });
}

async function restore(
  request: Request,
  userId: string,
  snapshotId: string,
  env: Env,
  requestId: string
): Promise<Response> {
  const parsed = await bodyObject(request);
  if (!parsed.ok) return bodyError(requestId, parsed, 'Explicit restore confirmation is required');
  const body = parsed.value;
  if (Object.keys(body).length !== 1 || body.confirm !== true) {
    return jsonError(requestId, 400, 'bad_request', 'Explicit restore confirmation is required');
  }
  const snapshot = await env.DB.prepare(
    `SELECT id, created_at, session_count, checksum, payload FROM backup_snapshots WHERE id = ? AND user_id = ?`
  ).bind(snapshotId, userId).first<SnapshotRow>();
  if (!snapshot) return jsonError(requestId, 404, 'not_found', 'Backup not found');
  const snapshotRows = await validatedSnapshotRows(snapshot);
  if (!snapshotRows) return jsonError(requestId, 500, 'internal_error', 'Backup snapshot is invalid');
  const current = await env.DB.prepare(
    'SELECT id, updated_at FROM sessions WHERE user_id = ?'
  ).bind(userId).all<{ id: string; updated_at: string }>();
  const snapshotIds = new Set(snapshotRows.map((row) => row.id));
  const preservedNewerCount = current.results.filter((row) =>
    row.updated_at > snapshot.created_at || !snapshotIds.has(row.id)
  ).length;
  const statements = snapshotRows.map((row) => env.DB.prepare(
    `INSERT INTO sessions (user_id, id, session_date, category, effort, payload, revision, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, id) DO UPDATE SET
       session_date = excluded.session_date,
       category = excluded.category,
       effort = excluded.effort,
       payload = excluded.payload,
       revision = sessions.revision + 1,
       updated_at = excluded.updated_at
     WHERE sessions.updated_at <= ?`
  ).bind(userId, row.id, row.session_date, row.category, row.effort, row.payload,
    row.revision, row.updated_at, row.updated_at, snapshot.created_at));
  if (statements.length) await env.DB.batch(statements);
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO restore_activity (id, user_id, snapshot_id, action, created_at, preserved_newer_count)
     VALUES (?, ?, ?, 'restored', ?, ?)`
  ).bind(crypto.randomUUID(), userId, snapshot.id, now, preservedNewerCount).run();
  return jsonResponse({ restored: true, restoredSessions: statements.length, preservedNewerCount });
}

export async function handleBackupRequest(
  request: Request,
  env: Env,
  requestId: string
): Promise<Response> {
  const url = new URL(request.url);
  try {
    if (url.pathname === '/v1/backups/github-installation/callback' && request.method === 'GET') {
      return await completeGitHubInstallation(request, env);
    }
    if (url.pathname === '/v1/backups/github-installation' && request.method === 'GET') {
      return await githubInstallationStatus(request, env);
    }
    if (url.pathname === '/v1/backups/github-installation' && request.method === 'POST') {
      return await beginGitHubInstallation(request, env, requestId);
    }
    if (url.pathname === '/v1/backups/github-installation' && request.method === 'DELETE') {
      return await revokeGitHubInstallation(request, env);
    }
    if (url.pathname === '/v1/backups/status' && request.method === 'GET') {
      return await status(request, env, requestId);
    }
    if (url.pathname === '/v1/backups' && request.method === 'POST') {
      return await requestBackup(request, env, requestId);
    }
    const preview = url.pathname.match(/^\/v1\/backups\/([A-Za-z0-9_-]{1,100})\/restore-preview$/);
    if (preview && request.method === 'GET') {
      const principal = await authenticateRequest(request, env, 'backups:restore');
      return await previewRestore(principal.userId, preview[1]!, env, requestId);
    }
    const restoreMatch = url.pathname.match(/^\/v1\/backups\/([A-Za-z0-9_-]{1,100})\/restore$/);
    if (restoreMatch && request.method === 'POST') {
      const principal = await authenticateRequest(request, env, 'backups:restore');
      return await restore(request, principal.userId, restoreMatch[1]!, env, requestId);
    }
    return jsonError(requestId, 405, 'method_not_allowed', 'Method not allowed');
  } catch (error) {
    if (error instanceof AuthFailure) return authError(error, requestId);
    throw error;
  }
}

type SnapshotRow = {
  id: string;
  created_at: string;
  session_count: number;
  checksum: string;
  payload: string;
};

async function validatedSnapshotRows(snapshot: SnapshotRow): Promise<SnapshotSession[] | null> {
  if (
    !snapshot.id ||
    !isCanonicalTimestamp(snapshot.created_at) ||
    !Number.isInteger(snapshot.session_count) || snapshot.session_count < 0 ||
    !/^[a-f0-9]{64}$/.test(snapshot.checksum)
  ) return null;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(snapshot.payload));
  if (hex(new Uint8Array(digest)) !== snapshot.checksum) return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(snapshot.payload) as unknown;
  } catch {
    return null;
  }
  if (!Array.isArray(decoded) || decoded.length !== snapshot.session_count) return null;
  const seen = new Set<string>();
  const rows: SnapshotSession[] = [];
  for (const value of decoded) {
    if (
      !isJsonObject(value) ||
      typeof value.id !== 'string' ||
      typeof value.session_date !== 'string' ||
      typeof value.category !== 'string' ||
      !isSessionCategory(value.category) ||
      !isEffortLevel(value.effort) ||
      typeof value.payload !== 'string' ||
      !Number.isInteger(value.revision) || (value.revision as number) < 1 ||
      typeof value.updated_at !== 'string' ||
      !isCanonicalTimestamp(value.updated_at) ||
      seen.has(value.id)
    ) return null;
    let payload: unknown;
    try {
      payload = JSON.parse(value.payload) as unknown;
    } catch {
      return null;
    }
    if (!isJsonObject(payload)) return null;
    const validation = validateSessionPayload(payload, {
      routeId: value.id,
      generateIdWhenMissing: false,
    });
    if (
      !validation.ok ||
      payload.id !== value.id ||
      validation.session.id !== value.id ||
      validation.session.date !== value.session_date ||
      validation.session.category !== value.category ||
      validation.session.effort !== value.effort
    ) return null;
    seen.add(value.id);
    rows.push(value as unknown as SnapshotSession);
  }
  return rows;
}

export async function processBackupMessage(
  message: Message<BackupMessage>,
  env: Env
): Promise<void> {
  const { jobId, userId } = message.body;
  const job = await env.DB.prepare(
    'SELECT status FROM backup_jobs WHERE id = ? AND user_id = ?'
  ).bind(jobId, userId).first<{ status: string }>();
  if (!job || job.status === 'completed' || job.status === 'failed') {
    message.ack();
    return;
  }
  await env.DB.prepare(
    `UPDATE backup_jobs SET status = 'running', error_code = NULL WHERE id = ? AND user_id = ? AND status IN ('queued', 'running')`
  ).bind(jobId, userId).run();
  try {
    const rows = await env.DB.prepare(
      `SELECT id, session_date, category, effort, payload, revision, updated_at
       FROM sessions WHERE user_id = ? ORDER BY session_date DESC, id DESC`
    ).bind(userId).all<SnapshotSession>();
    const existing = await env.DB.prepare(
      `SELECT id, created_at, session_count, checksum, payload FROM backup_snapshots WHERE job_id = ? AND user_id = ?`
    ).bind(jobId, userId).first<SnapshotRow>();
    let snapshotId = existing?.id;
    let createdAt = existing?.created_at;
    let snapshotRows = rows.results;
    if (existing) {
      const validRows = await validatedSnapshotRows(existing);
      if (!validRows) throw new Error('Backup snapshot is invalid');
      snapshotRows = validRows;
    } else {
      createdAt = new Date().toISOString();
      snapshotId = crypto.randomUUID();
      const payload = JSON.stringify(snapshotRows);
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
      const checksum = Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('');
      const validatedRows = await validatedSnapshotRows({
        id: snapshotId, created_at: createdAt, session_count: snapshotRows.length, checksum, payload,
      });
      if (!validatedRows) throw new Error('Session snapshot is invalid');
      snapshotRows = validatedRows;
      await env.DB.prepare(
        `INSERT INTO backup_snapshots (id, user_id, job_id, created_at, session_count, checksum, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).bind(snapshotId, userId, jobId, createdAt, snapshotRows.length, checksum, payload).run();
    }
    const installation = await env.DB.prepare(
      `SELECT user_id, installation_id, repository_owner, repository_name, repository_id
       FROM github_installations WHERE user_id = ? AND revoked_at IS NULL`
    ).bind(userId).first<{
      user_id: string;
      installation_id: number;
      repository_owner: string;
      repository_name: string;
      repository_id: number;
    }>();
    if (installation && snapshotId && createdAt) {
      await writeGitHubBackup(env, installation, snapshotId, createdAt, snapshotRows);
    }
    const completedAt = new Date().toISOString();
    await env.DB.prepare(
      `UPDATE backup_jobs SET status = 'completed', completed_at = ?, error_code = NULL WHERE id = ? AND user_id = ?`
    ).bind(completedAt, jobId, userId).run();
    message.ack();
  } catch {
    await env.DB.prepare(
      `UPDATE backup_jobs SET status = ?, error_code = 'backup_failed' WHERE id = ? AND user_id = ?`
    ).bind(message.attempts >= 5 ? 'failed' : 'queued', jobId, userId).run();
    message.retry({ delaySeconds: Math.min(300, 2 ** message.attempts * 5) });
  }
}
