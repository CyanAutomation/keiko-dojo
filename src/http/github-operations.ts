import { authenticateRequest, AuthFailure } from '../auth/bearer-auth';
import {
  isSafeSessionMarkdownPath,
  normalizeSessionMarkdown,
  parseSessionMarkdown,
} from '../domain/github-session-markdown';
import { isJsonObject } from '../domain/session';
import {
  checkSelectedGitHubRepository,
  listSelectedGitHubSessionMarkdown,
  updateSelectedGitHubMarkdown,
} from '../integrations/github-app';
import { dispatchGitHubSessionSync } from '../application/github-session-sync-queue';
import { authFailureResponse } from './auth-errors';
import { readJsonBodyLimited } from './request-body';
import { jsonError, jsonResponse } from './responses';

type GitHubOperationType = 'github-health' | 'log-doctor-scan' | 'log-doctor-fix' | 'github-sync-all';
type GitHubFixPayload = {
  branch?: string;
  mode: 'dry-run' | 'apply';
  paths: string[];
};
type GitHubOperationMessage = { kind: 'github-operation'; jobId: string; userId: string };
type OperationJob = {
  id: string;
  user_id: string;
  type: GitHubOperationType;
  status: 'queued' | 'running' | 'completed' | 'failed';
  payload: string;
  result: string | null;
  error_message: string | null;
  attempts: number;
  created_at: string;
  updated_at: string;
};
type Installation = {
  user_id: string;
  installation_id: number;
  repository_owner: string;
  repository_name: string;
  repository_id: number;
};

const MAX_FIX_FILES = 25;

async function bodyObject(request: Request, requestId: string): Promise<Record<string, unknown> | Response> {
  const parsed = await readJsonBodyLimited(request, 64 * 1024);
  if (!parsed.ok) {
    return jsonError(requestId, parsed.reason === 'too_large' ? 413 : 400,
      parsed.reason === 'too_large' ? 'payload_too_large' : 'bad_request',
      parsed.reason === 'too_large' ? 'Request body exceeds the 64 KiB limit' : 'Invalid JSON body');
  }
  if (!isJsonObject(parsed.value)) return jsonError(requestId, 400, 'bad_request', 'Expected a JSON object');
  return parsed.value;
}

function exactKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function readBranch(body: Record<string, unknown>): string | undefined | null {
  if (!('branch' in body)) return undefined;
  if (typeof body.branch !== 'string') return null;
  const branch = body.branch.trim();
  if (!branch || branch.length > 255 || /[\u0000-\u001f\u007f]/.test(branch)) return null;
  return branch;
}

function jobResponse(job: OperationJob): Record<string, unknown> {
  let result: unknown;
  if (job.result !== null) {
    try { result = JSON.parse(job.result) as unknown; } catch { result = undefined; }
  }
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    attempts: job.attempts,
    createdAt: new Date(job.created_at).toISOString(),
    updatedAt: new Date(job.updated_at).toISOString(),
    ...(result === undefined ? {} : { result }),
    ...(job.error_message ? { error: job.error_message } : {}),
  };
}

async function connectedInstallation(userId: string, env: Env): Promise<Installation | null> {
  return env.DB.prepare(
    `SELECT user_id, installation_id, repository_owner, repository_name, repository_id
     FROM github_installations WHERE user_id = ? AND revoked_at IS NULL`
  ).bind(userId).first<Installation>();
}

async function enqueueOperation(
  env: Env,
  userId: string,
  type: GitHubOperationType,
  payload: Record<string, unknown>,
  requestId: string
): Promise<Response> {
  const installation = await connectedInstallation(userId, env);
  if (!installation) return jsonError(requestId, 409, 'not_found', 'Connect a GitHub App repository first');
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO github_operation_jobs (id, user_id, type, status, payload, created_at, updated_at)
     VALUES (?, ?, ?, 'queued', ?, ?, ?)`
  ).bind(id, userId, type, JSON.stringify(payload), now, now).run();
  try {
    await env.BACKUP_QUEUE.send({ kind: 'github-operation', jobId: id, userId } satisfies GitHubOperationMessage);
  } catch {
    await env.DB.prepare(
      `UPDATE github_operation_jobs SET status = 'failed', error_message = 'queue_unavailable', updated_at = ?, completed_at = ?
       WHERE id = ? AND user_id = ?`
    ).bind(new Date().toISOString(), new Date().toISOString(), id, userId).run();
    return jsonError(requestId, 503, 'internal_error', 'GitHub operation queue is unavailable');
  }
  const job = await env.DB.prepare(
    `SELECT id, user_id, type, status, payload, result, error_message, attempts, created_at, updated_at
     FROM github_operation_jobs WHERE id = ? AND user_id = ?`
  ).bind(id, userId).first<OperationJob>();
  return jsonResponse(job ? jobResponse(job) : { id, type, status: 'queued', createdAt: now, updatedAt: now, attempts: 0 }, 202);
}

function validateFixPayload(body: Record<string, unknown>): GitHubFixPayload | null {
  const branch = readBranch(body);
  if (branch === null || !exactKeys(body, ['branch', 'mode', 'paths', 'confirmApply', 'options'])) return null;
  if (body.mode !== 'dry-run' && body.mode !== 'apply') return null;
  if (!Array.isArray(body.paths) || body.paths.length < 1 || body.paths.length > MAX_FIX_FILES ||
      !body.paths.every((path) => typeof path === 'string' && isSafeSessionMarkdownPath(path))) return null;
  if (new Set(body.paths).size !== body.paths.length) return null;
  if (body.mode === 'apply' ? body.confirmApply !== true : body.confirmApply === true) return null;
  if (body.options !== undefined) {
    if (!isJsonObject(body.options) || !exactKeys(body.options, ['normalizeFrontmatter', 'enforceSectionOrder', 'preserveUserContent']) ||
        Object.values(body.options).some((value) => value !== true)) return null;
  }
  return { ...(branch ? { branch } : {}), mode: body.mode, paths: body.paths as string[] };
}

async function createSyncJob(request: Request, env: Env, requestId: string): Promise<Response> {
  const principal = await authenticateRequest(request, env, 'github:write');
  const body = await bodyObject(request, requestId);
  if (body instanceof Response) return body;
  if (!exactKeys(body, [])) return jsonError(requestId, 400, 'bad_request', 'Invalid sync request');
  const installation = await connectedInstallation(principal.userId, env);
  if (!installation) return jsonError(requestId, 409, 'not_found', 'Connect a GitHub App repository first');
  const id = crypto.randomUUID();
  const requestedAt = new Date().toISOString();
  const nextSyncAt = requestedAt;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO github_operation_jobs (id, user_id, type, status, payload, created_at, updated_at)
       VALUES (?, ?, 'github-sync-all', 'queued', '{}', ?, ?)`
    ).bind(id, principal.userId, requestedAt, requestedAt),
    env.DB.prepare(
      `INSERT INTO github_session_sync_state
       (user_id, repository_id, generation, full_sync_required, next_sync_at)
       VALUES (?, ?, 1, 1, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         repository_id = excluded.repository_id,
         generation = github_session_sync_state.generation + 1,
         full_sync_required = 1,
         next_sync_at = excluded.next_sync_at,
         dispatch_after = NULL,
         last_error = NULL`
    ).bind(principal.userId, installation.repository_id, nextSyncAt),
  ]);
  const queued = await dispatchGitHubSessionSync(env, principal.userId, {
    immediate: true,
    operationId: id,
    force: true,
  });
  if (!queued) {
    const failedAt = new Date().toISOString();
    await env.DB.prepare(
      `UPDATE github_operation_jobs SET status = 'failed', error_message = 'queue_unavailable',
       updated_at = ?, completed_at = ? WHERE id = ? AND user_id = ?`
    ).bind(failedAt, failedAt, id, principal.userId).run();
    return jsonError(requestId, 503, 'internal_error', 'GitHub operation queue is unavailable');
  }
  return jsonResponse({ id, type: 'github-sync-all', status: 'queued', createdAt: requestedAt, updatedAt: requestedAt, attempts: 0 }, 202);
}

async function getJob(request: Request, env: Env, jobId: string, requestId: string): Promise<Response> {
  const principal = await authenticateRequest(request, env, 'github:read');
  const job = await env.DB.prepare(
    `SELECT id, user_id, type, status, payload, result, error_message, attempts, created_at, updated_at
     FROM github_operation_jobs WHERE id = ? AND user_id = ?`
  ).bind(jobId, principal.userId).first<OperationJob>();
  return job ? jsonResponse(jobResponse(job)) : jsonError(requestId, 404, 'not_found', 'GitHub job not found');
}

export async function handleGitHubOperationRequest(
  request: Request,
  env: Env,
  requestId: string
): Promise<Response> {
  const url = new URL(request.url);
  try {
    if (url.pathname === '/v1/github/sync-all' && request.method === 'POST') return await createSyncJob(request, env, requestId);
    const jobMatch = url.pathname.match(/^\/v1\/github\/jobs\/([A-Za-z0-9_-]{1,100})$/);
    if (jobMatch && request.method === 'GET') return await getJob(request, env, jobMatch[1]!, requestId);
    if (url.pathname === '/v1/github/health' && request.method === 'POST') {
      const principal = await authenticateRequest(request, env, 'github:read');
      const body = await bodyObject(request, requestId);
      if (body instanceof Response) return body;
      const branch = readBranch(body);
      if (branch === null || !exactKeys(body, ['branch'])) return jsonError(requestId, 400, 'bad_request', 'Invalid health check request');
      return await enqueueOperation(env, principal.userId, 'github-health', branch ? { branch } : {}, requestId);
    }
    if (url.pathname === '/v1/github/log-doctor' && request.method === 'POST') {
      const principal = await authenticateRequest(request, env, 'github:read');
      const body = await bodyObject(request, requestId);
      if (body instanceof Response) return body;
      const branch = readBranch(body);
      if (branch === null || !exactKeys(body, ['branch'])) return jsonError(requestId, 400, 'bad_request', 'Invalid Log Doctor scan request');
      return await enqueueOperation(env, principal.userId, 'log-doctor-scan', branch ? { branch } : {}, requestId);
    }
    if (url.pathname === '/v1/github/log-doctor/fix' && request.method === 'POST') {
      const principal = await authenticateRequest(request, env, 'github:write');
      const body = await bodyObject(request, requestId);
      if (body instanceof Response) return body;
      const payload = validateFixPayload(body);
      if (!payload) return jsonError(requestId, 400, 'bad_request', 'Invalid Log Doctor fix request');
      return await enqueueOperation(env, principal.userId, 'log-doctor-fix', payload, requestId);
    }
    return jsonError(requestId, 405, 'method_not_allowed', 'Method not allowed');
  } catch (error) {
    if (error instanceof AuthFailure) return authFailureResponse(error, requestId);
    throw error;
  }
}

function simpleDiff(path: string, original: string, updated: string): string {
  const originalLines = original.split('\n');
  const updatedLines = updated.split('\n');
  const lines = [
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,${originalLines.length} +1,${updatedLines.length} @@`,
    ...originalLines.map((line) => `-${line}`),
    ...updatedLines.map((line) => `+${line}`),
  ];
  const diff = lines.join('\n');
  return diff.length > 64 * 1024 ? `${diff.slice(0, 64 * 1024)}\n... diff truncated` : diff;
}

async function runFix(
  env: Env,
  installation: Installation,
  payload: GitHubFixPayload
): Promise<Record<string, unknown>> {
  const listed = await listSelectedGitHubSessionMarkdown(env, installation, payload.branch);
  const filesByPath = new Map(listed.files.map((file) => [file.path, file]));
  const results = [];
  for (const path of payload.paths) {
    const file = filesByPath.get(path);
    if (!file) {
      results.push({ path, status: 'error', message: 'Session file was not found on the selected branch', validationState: { before: 'unknown', after: 'unknown', errors: ['File not found'] }, preview: { changed: false, diff: '', originalBytes: 0, updatedBytes: 0 } });
      continue;
    }
    const normalized = normalizeSessionMarkdown(file.content);
    if (normalized.errors.length) {
      results.push({ path, status: 'error', message: normalized.errors[0], validationState: { before: 'invalid', after: 'invalid', errors: normalized.errors }, preview: { changed: false, diff: '', originalBytes: new TextEncoder().encode(file.content).byteLength, updatedBytes: new TextEncoder().encode(file.content).byteLength } });
      continue;
    }
    const originalBytes = new TextEncoder().encode(file.content).byteLength;
    const updatedBytes = new TextEncoder().encode(normalized.markdown).byteLength;
    if (!normalized.changed) {
      results.push({ path, status: 'unchanged', message: 'File already matches the supported format', validationState: { before: 'valid', after: 'valid' }, preview: { changed: false, diff: '', originalBytes, updatedBytes } });
      continue;
    }
    if (payload.mode === 'apply') {
      const commitSha = await updateSelectedGitHubMarkdown(env, installation, listed.branch, file, normalized.markdown, file.content);
      results.push({ path, status: 'applied', message: 'Normalized session Markdown', commitSha, validationState: { before: 'valid', after: 'valid' }, preview: { changed: true, diff: simpleDiff(path, file.content, normalized.markdown), originalBytes, updatedBytes } });
    } else {
      results.push({ path, status: 'preview', message: 'File can be normalized', validationState: { before: 'valid', after: 'valid' }, preview: { changed: true, diff: simpleDiff(path, file.content, normalized.markdown), originalBytes, updatedBytes } });
    }
  }
  const hasErrors = results.some((result) => result.status === 'error');
  return {
    success: !hasErrors,
    message: payload.mode === 'apply'
      ? `Applied Log Doctor fixes to ${results.filter((result) => result.status === 'applied').length} file(s).`
      : `Prepared Log Doctor previews for ${results.filter((result) => result.status === 'preview').length} file(s).`,
    mode: payload.mode,
    branch: listed.branch,
    files: results,
  };
}

async function processOperation(
  job: OperationJob,
  installation: Installation,
  env: Env
): Promise<unknown> {
  const payload = JSON.parse(job.payload) as Record<string, unknown>;
  const branch = typeof payload.branch === 'string' ? payload.branch : undefined;
  if (job.type === 'github-health') return checkSelectedGitHubRepository(env, installation, branch);
  if (job.type === 'log-doctor-scan') {
    const listed = await listSelectedGitHubSessionMarkdown(env, installation, branch);
    const files = listed.files.map((file) => {
      const parsed = parseSessionMarkdown(file.content);
      return parsed.ok
        ? { path: file.path, status: 'valid' as const, id: parsed.session.id, date: parsed.session.date }
        : { path: file.path, status: 'invalid' as const, errors: parsed.errors, ...(parsed.id ? { id: parsed.id } : {}), ...(parsed.date ? { date: parsed.date } : {}) };
    });
    const invalidFiles = files.filter((file) => file.status === 'invalid').length;
    return {
      success: invalidFiles === 0,
      message: invalidFiles === 0
        ? `Checked ${files.length} training file(s).`
        : `Checked ${files.length} training file(s); ${invalidFiles} need attention.`,
      branch: listed.branch,
      summary: { totalFiles: files.length, validFiles: files.length - invalidFiles, invalidFiles },
      files,
    };
  }
  if (job.type === 'log-doctor-fix') {
    const fixPayload = validateFixPayload({ ...payload, confirmApply: payload.mode === 'apply' });
    if (!fixPayload) throw new Error('Stored Log Doctor request is invalid');
    return runFix(env, installation, fixPayload);
  }
  throw new Error('Unsupported GitHub operation');
}

export async function processGitHubOperationMessage(
  message: Message<GitHubOperationMessage>,
  env: Env
): Promise<void> {
  const { jobId, userId } = message.body;
  const job = await env.DB.prepare(
    `SELECT id, user_id, type, status, payload, result, error_message, attempts, created_at, updated_at
     FROM github_operation_jobs WHERE id = ? AND user_id = ?`
  ).bind(jobId, userId).first<OperationJob>();
  if (!job || job.status === 'completed') { message.ack(); return; }
  const now = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE github_operation_jobs SET status = 'running', error_message = NULL, attempts = attempts + 1, updated_at = ?
     WHERE id = ? AND user_id = ? AND status IN ('queued', 'running')`
  ).bind(now, jobId, userId).run();
  try {
    const installation = await connectedInstallation(userId, env);
    if (!installation) throw new Error('GitHub App connection was removed');
    const result = await processOperation(job, installation, env);
    const completedAt = new Date().toISOString();
    await env.DB.prepare(
      `UPDATE github_operation_jobs SET status = 'completed', result = ?, error_message = NULL, updated_at = ?, completed_at = ?
       WHERE id = ? AND user_id = ?`
    ).bind(JSON.stringify(result), completedAt, completedAt, jobId, userId).run();
    message.ack();
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'GitHub operation failed';
    const terminal = message.attempts >= 5;
    const updatedAt = new Date().toISOString();
    await env.DB.prepare(
      `UPDATE github_operation_jobs SET status = ?, error_message = ?, updated_at = ?, completed_at = ?
       WHERE id = ? AND user_id = ? AND status != 'completed'`
    ).bind(terminal ? 'failed' : 'queued', terminal ? errorMessage : null, updatedAt, terminal ? updatedAt : null, jobId, userId).run();
    if (terminal) {
      message.ack();
    } else {
      message.retry({ delaySeconds: Math.min(300, 2 ** message.attempts * 5) });
    }
  }
}
