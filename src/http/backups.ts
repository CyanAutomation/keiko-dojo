import { authenticateRequest, AuthFailure } from '../auth/bearer-auth';
import { isJsonObject } from '../domain/session';
import { dispatchGitHubSessionSync } from '../application/github-session-sync-queue';
import { configuredGitHubInstallUrl, isGitHubAppConfigured } from '../integrations/github-app-config';
import {
  GitHubInstallationVerificationError,
  verifySelectedRepositoryInstallation,
} from '../integrations/github-app';
import { authFailureResponse } from './auth-errors';
import { readJsonBodyLimited } from './request-body';
import { jsonError, jsonResponse } from './responses';

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
  const target = new URL('/', frontendOrigin(env));
  target.searchParams.set('githubBackup', result);
  return new Response(null, {
    status: 302,
    headers: { Location: target.href, 'Cache-Control': 'no-store' },
  });
}

async function beginGitHubInstallation(request: Request, env: Env, requestId: string): Promise<Response> {
  const principal = await authenticateRequest(request, env, 'backups:write');
  const parsed = await bodyObject(request);
  if (!parsed.ok) return bodyError(requestId, parsed, 'Invalid installation request');
  if (Object.keys(parsed.value).length !== 0) return jsonError(requestId, 400, 'bad_request', 'Invalid installation request');
  const privateKey = (env as Env & { GITHUB_APP_PRIVATE_KEY?: string }).GITHUB_APP_PRIVATE_KEY;
  const installUrl = configuredGitHubInstallUrl(env.GITHUB_APP_INSTALL_URL);
  if (!isGitHubAppConfigured(env.GITHUB_APP_ID, env.GITHUB_APP_INSTALL_URL, privateKey) || !installUrl) {
    return jsonError(requestId, 503, 'internal_error', 'GitHub App is not configured');
  }
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
  const consumedAt = new Date().toISOString();
  const pending = await env.DB.prepare(
    `UPDATE github_installation_states SET consumed_at = ?
     WHERE state_hash = ? AND consumed_at IS NULL AND expires_at > ?
     RETURNING user_id`
  ).bind(consumedAt, stateHash, consumedAt).first<{ user_id: string }>();
  if (!pending) return githubResultRedirect(env, 'failed');

  try {
    const repository = await verifySelectedRepositoryInstallation(env, installationId);
    const nextSyncAt = new Date(Date.now() + 60_000).toISOString();
    await env.DB.batch([
      env.DB.prepare(
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
        repository.repository_name, repository.repository_id, consumedAt),
      env.DB.prepare(
        `INSERT INTO github_session_sync_state
         (user_id, repository_id, generation, full_sync_required, next_sync_at)
         VALUES (?, ?, 1, 1, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           repository_id = excluded.repository_id,
           generation = github_session_sync_state.generation + 1,
           full_sync_required = 1,
           next_sync_at = excluded.next_sync_at,
           wake_enqueued = 0,
           wake_enqueued_at = NULL,
           dispatch_after = NULL,
           lease_token = NULL,
           lease_expires_at = NULL,
           last_synced_at = NULL,
           last_error = NULL`
      ).bind(pending.user_id, repository.repository_id, nextSyncAt),
      env.DB.prepare('DELETE FROM github_synced_session_files WHERE user_id = ?')
        .bind(pending.user_id),
    ]);
    try {
      await dispatchGitHubSessionSync(env, pending.user_id);
    } catch {
      // The connection and initial-sync request are durable; the cron
      // dispatcher will queue the sync if this wake-up cannot be sent.
      console.error('github_initial_sync_dispatch_failed');
    }
    return githubResultRedirect(env, 'connected');
  } catch (error) {
    if (error instanceof GitHubInstallationVerificationError) {
      console.error('github_installation_verification_failed', {
        phase: error.phase,
        status: error.status ?? null,
        causeName: error.causeName ?? null,
        causeCode: error.causeCode ?? null,
        reason: error.reason ?? null,
        redirectOrigin: error.redirectOrigin ?? null,
        redirectPath: error.redirectPath ?? null,
        apiErrorCategory: error.apiErrorCategory ?? null,
      });
    }
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
  await env.DB.batch([
    env.DB.prepare('DELETE FROM github_session_sync_state WHERE user_id = ?').bind(principal.userId),
    env.DB.prepare('DELETE FROM github_synced_session_files WHERE user_id = ?').bind(principal.userId),
    env.DB.prepare(
      `UPDATE github_installations SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`
    ).bind(new Date().toISOString(), principal.userId),
  ]);
  return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
}

async function status(request: Request, env: Env): Promise<Response> {
  const principal = await authenticateRequest(request, env, 'backups:read');
  const [installation, sync] = await Promise.all([
    env.DB.prepare(
      `SELECT repository_owner AS owner, repository_name AS repository
       FROM github_installations WHERE user_id = ? AND revoked_at IS NULL`
    ).bind(principal.userId).first<{ owner: string; repository: string }>(),
    env.DB.prepare(
      `SELECT state.generation, state.completed_generation AS completedGeneration,
         state.full_sync_required AS fullSyncRequired, state.next_sync_at AS nextSyncAt,
         state.last_synced_at AS lastSyncedAt, state.last_error AS lastError,
         EXISTS (SELECT 1 FROM github_session_sync_items AS item WHERE item.user_id = state.user_id)
           AS hasPendingItems
       FROM github_session_sync_state AS state WHERE state.user_id = ?`
    ).bind(principal.userId).first<{
      generation: number;
      completedGeneration: number;
      fullSyncRequired: number;
      nextSyncAt: string;
      lastSyncedAt: string | null;
      lastError: string | null;
      hasPendingItems: number;
    }>(),
  ]);
  const pending = Boolean(sync && (
    sync.fullSyncRequired === 1 || sync.generation > sync.completedGeneration || sync.hasPendingItems === 1
  ));
  return jsonResponse({
    configured: Boolean(installation),
    installation: installation ?? null,
    pending,
    nextSyncAt: pending ? sync?.nextSyncAt ?? null : null,
    lastSyncedAt: sync?.lastSyncedAt ?? null,
    error: sync?.lastError ?? null,
  });
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
      return await status(request, env);
    }
    return jsonError(requestId, 405, 'method_not_allowed', 'Method not allowed');
  } catch (error) {
    if (error instanceof AuthFailure) return authFailureResponse(error, requestId);
    throw error;
  }
}
