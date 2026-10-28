import type { GitHubSessionSyncMessage } from '../application/github-session-sync-queue';
import { dispatchGitHubSessionSync } from '../application/github-session-sync-queue';
import {
  githubSessionMarkdownPathForRow,
  isKeikoSessionMarkdownPath,
  listSelectedGitHubSessionMarkdown,
  syncGitHubSessionMarkdown,
  type GitHubSessionRow,
} from '../integrations/github-app';

type SyncState = {
  user_id: string;
  repository_id: number;
  generation: number;
  full_sync_required: number;
  next_sync_at: string;
  wake_enqueued: number;
  lease_token: string | null;
};
type Installation = {
  user_id: string;
  installation_id: number;
  repository_owner: string;
  repository_name: string;
  repository_id: number;
};
type SyncItem = { session_id: string; generation: number };
type SyncedFile = { session_id: string; path: string; revision: number };

const MAX_SYNC_ITEMS_PER_BATCH = 50;
const MAX_FULL_SYNC_SESSIONS = 500;
const LEASE_SECONDS = 15 * 60;

class FullSyncSessionLimitError extends Error {
  constructor() {
    super('GitHub session sync exceeds the supported file count');
    this.name = 'FullSyncSessionLimitError';
  }
}

async function rowsForIds(
  env: Env,
  userId: string,
  sessionIds: string[]
): Promise<GitHubSessionRow[]> {
  if (!sessionIds.length) return [];
  const placeholders = sessionIds.map(() => '?').join(', ');
  const result = await env.DB.prepare(
    `SELECT id, session_date, category, effort, payload, revision, updated_at
     FROM sessions WHERE user_id = ? AND id IN (${placeholders})`
  ).bind(userId, ...sessionIds).all<GitHubSessionRow>();
  return result.results;
}

async function upsertSyncedFiles(
  env: Env,
  userId: string,
  repositoryId: number,
  files: SyncedFile[],
  removedIds: string[],
  replaceRepositoryManifest: boolean
): Promise<void> {
  const statements: D1PreparedStatement[] = [];
  if (replaceRepositoryManifest) {
    statements.push(env.DB.prepare(
      'DELETE FROM github_synced_session_files WHERE user_id = ? AND repository_id = ?'
    ).bind(userId, repositoryId));
  } else {
    for (const sessionId of removedIds) {
      statements.push(env.DB.prepare(
        'DELETE FROM github_synced_session_files WHERE user_id = ? AND repository_id = ? AND session_id = ?'
      ).bind(userId, repositoryId, sessionId));
    }
  }
  for (const file of files) {
    statements.push(env.DB.prepare(
      `INSERT INTO github_synced_session_files
       (user_id, repository_id, session_id, path, revision) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id, repository_id, session_id) DO UPDATE SET
         path = excluded.path, revision = excluded.revision`
    ).bind(userId, repositoryId, file.session_id, file.path, file.revision));
  }
  if (statements.length) await env.DB.batch(statements);
}

async function setOperationStatus(
  env: Env,
  operationId: string | undefined,
  userId: string,
  status: 'running' | 'completed' | 'failed' | 'queued',
  result?: Record<string, unknown>,
  error?: string
): Promise<void> {
  if (!operationId) return;
  const now = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE github_operation_jobs SET status = ?, result = ?, error_message = ?,
       attempts = CASE WHEN ? = 'running' THEN attempts + 1 ELSE attempts END,
       updated_at = ?, completed_at = ?
     WHERE id = ? AND user_id = ? AND type = 'github-sync-all'`
  ).bind(status, result ? JSON.stringify(result) : null, error ?? null, status,
    now, status === 'completed' || status === 'failed' ? now : null, operationId, userId).run();
}

async function completeNoop(
  env: Env,
  userId: string,
  operationId: string | undefined,
  generation: number,
  leaseToken: string
): Promise<void> {
  const now = new Date().toISOString();
  const result = await env.DB.prepare(
    `UPDATE github_session_sync_state
     SET completed_generation = generation, full_sync_required = 0, last_synced_at = COALESCE(last_synced_at, ?),
         last_error = NULL, wake_enqueued = 0, wake_enqueued_at = NULL,
         lease_token = NULL, lease_expires_at = NULL
     WHERE user_id = ? AND generation = ? AND lease_token = ?
       AND NOT EXISTS (SELECT 1 FROM github_session_sync_items WHERE user_id = ?)`
  ).bind(now, userId, generation, leaseToken, userId).run();
  if (result.meta.changes !== 1) {
    await env.DB.prepare(
      `UPDATE github_session_sync_state
       SET lease_token = NULL, lease_expires_at = NULL, wake_enqueued = 0,
           wake_enqueued_at = NULL, dispatch_after = NULL
       WHERE user_id = ? AND lease_token = ?`
    ).bind(userId, leaseToken).run();
    await dispatchGitHubSessionSync(env, userId);
    return;
  }
  await setOperationStatus(env, operationId, userId, 'completed', {
    success: true, message: 'GitHub Markdown is already in sync.', sessionCount: 0,
  });
}

export async function processGitHubSessionSyncMessage(
  message: Message<GitHubSessionSyncMessage>,
  env: Env
): Promise<void> {
  const { userId, operationId } = message.body;
  const now = new Date();
  const nowIso = now.toISOString();
  let leaseToken: string | null = null;

  try {
    const installation = await env.DB.prepare(
      `SELECT user_id, installation_id, repository_owner, repository_name, repository_id
       FROM github_installations WHERE user_id = ? AND revoked_at IS NULL`
    ).bind(userId).first<Installation>();
    const beforeLease = await env.DB.prepare(
      `SELECT user_id, repository_id, generation, full_sync_required, next_sync_at,
         wake_enqueued, lease_token
       FROM github_session_sync_state WHERE user_id = ?`
    ).bind(userId).first<SyncState>();

    if (!installation || !beforeLease) {
      if (operationId) {
        await setOperationStatus(env, operationId, userId, 'failed', undefined,
          installation ? 'sync_state_missing' : 'github_connection_missing');
      }
      message.ack();
      return;
    }

    if (Date.parse(beforeLease.next_sync_at) > now.getTime() && !operationId) {
      await env.DB.prepare(
        `UPDATE github_session_sync_state SET wake_enqueued = 0, wake_enqueued_at = NULL
         WHERE user_id = ? AND lease_token IS NULL`
      ).bind(userId).run();
      message.ack();
      await dispatchGitHubSessionSync(env, userId);
      return;
    }

    leaseToken = crypto.randomUUID();
    const leaseExpiresAt = new Date(now.getTime() + LEASE_SECONDS * 1000).toISOString();
    const claimed = await env.DB.prepare(
      `UPDATE github_session_sync_state SET lease_token = ?, lease_expires_at = ?
       WHERE user_id = ? AND repository_id = ? AND generation = ?
         AND (lease_token IS NULL OR lease_expires_at <= ?)
       RETURNING generation, full_sync_required`
    ).bind(leaseToken, leaseExpiresAt, userId, beforeLease.repository_id,
      beforeLease.generation, nowIso).first<{ generation: number; full_sync_required: number }>();
    if (!claimed) {
      if (operationId) {
        await setOperationStatus(env, operationId, userId, 'queued');
        message.retry({ delaySeconds: 15 });
      } else {
        message.ack();
      }
      return;
    }

    await setOperationStatus(env, operationId, userId, 'running');
    if (installation.repository_id !== beforeLease.repository_id) {
      throw new Error('GitHub repository changed during sync');
    }

    const capturedGeneration = claimed.generation;
    const fullSync = claimed.full_sync_required === 1;
    let rows: GitHubSessionRow[] = [];
    let items: SyncItem[] = [];
    let previousFiles: SyncedFile[] = [];
    let deletePaths: string[] = [];
    let replaceManifest = false;

    if (fullSync) {
      const result = await env.DB.prepare(
        `SELECT id, session_date, category, effort, payload, revision, updated_at
         FROM sessions WHERE user_id = ? ORDER BY session_date DESC, id DESC LIMIT ?`
      ).bind(userId, MAX_FULL_SYNC_SESSIONS + 1).all<GitHubSessionRow>();
      rows = result.results;
      if (rows.length > MAX_FULL_SYNC_SESSIONS) throw new FullSyncSessionLimitError();
      const expectedPaths = new Set(rows.map(githubSessionMarkdownPathForRow));
      const remote = await listSelectedGitHubSessionMarkdown(env, installation);
      deletePaths = remote.files
        .filter((file) => isKeikoSessionMarkdownPath(file.path) && !expectedPaths.has(file.path))
        .map((file) => file.path);
      replaceManifest = true;
    } else {
      const pendingItems = await env.DB.prepare(
        `SELECT session_id, generation FROM github_session_sync_items
         WHERE user_id = ? AND generation <= ?
         ORDER BY generation, session_id LIMIT ?`
      ).bind(userId, capturedGeneration, MAX_SYNC_ITEMS_PER_BATCH).all<SyncItem>();
      items = pendingItems.results;
      if (!items.length) {
        await completeNoop(env, userId, operationId, capturedGeneration, leaseToken);
        message.ack();
        return;
      }
      const ids = items.map((item) => item.session_id);
      rows = await rowsForIds(env, userId, ids);
      const idList = ids.map(() => '?').join(', ');
      const mapped = await env.DB.prepare(
        `SELECT session_id, path, revision FROM github_synced_session_files
         WHERE user_id = ? AND repository_id = ? AND session_id IN (${idList})`
      ).bind(userId, installation.repository_id, ...ids).all<SyncedFile>();
      previousFiles = mapped.results;
      const nextPaths = new Map(rows.map((row) => [row.id, githubSessionMarkdownPathForRow(row)]));
      deletePaths = previousFiles
        .filter((file) => nextPaths.get(file.session_id) !== file.path)
        .map((file) => file.path);
    }

    const synced = await syncGitHubSessionMarkdown(env, installation, rows, deletePaths);
    const syncedById = new Map(synced.map((file) => [file.id, file]));
    const removedIds = fullSync
      ? []
      : items.filter((item) => !syncedById.has(item.session_id)).map((item) => item.session_id);
    await upsertSyncedFiles(env, userId, installation.repository_id,
      synced.map((file) => ({ session_id: file.id, path: file.path, revision: file.revision })),
      removedIds, replaceManifest);

    const clearStatements: D1PreparedStatement[] = [];
    if (fullSync) {
      clearStatements.push(env.DB.prepare(
        'DELETE FROM github_session_sync_items WHERE user_id = ? AND generation <= ?'
      ).bind(userId, capturedGeneration));
    } else {
      for (const item of items) {
        clearStatements.push(env.DB.prepare(
          `DELETE FROM github_session_sync_items
           WHERE user_id = ? AND session_id = ? AND generation = ?`
        ).bind(userId, item.session_id, item.generation));
      }
    }
    if (clearStatements.length) await env.DB.batch(clearStatements);

    const completedAt = new Date().toISOString();
    const finalized = await env.DB.prepare(
      `UPDATE github_session_sync_state
       SET completed_generation = ?, full_sync_required = 0, last_synced_at = ?, last_error = NULL,
           wake_enqueued = 0, wake_enqueued_at = NULL,
           lease_token = NULL, lease_expires_at = NULL, dispatch_after = NULL
       WHERE user_id = ? AND generation = ? AND lease_token = ?
         AND NOT EXISTS (SELECT 1 FROM github_session_sync_items WHERE user_id = ?)`
    ).bind(capturedGeneration, completedAt, userId, capturedGeneration, leaseToken, userId).run();

    if (finalized.meta.changes !== 1) {
      await env.DB.prepare(
        `UPDATE github_session_sync_state
         SET lease_token = NULL, lease_expires_at = NULL, wake_enqueued = 0,
             wake_enqueued_at = NULL, dispatch_after = NULL
         WHERE user_id = ? AND lease_token = ?`
      ).bind(userId, leaseToken).run();
      await dispatchGitHubSessionSync(env, userId);
    }

    await setOperationStatus(env, operationId, userId, 'completed', {
      success: true,
      message: `Synced ${synced.length} training session(s) to GitHub Markdown.`,
      sessionCount: synced.length,
    });
    message.ack();
  } catch (error) {
    if (error instanceof FullSyncSessionLimitError) {
      await env.DB.prepare(
        `UPDATE github_session_sync_state
         SET lease_token = NULL, lease_expires_at = NULL, wake_enqueued = 0,
             wake_enqueued_at = NULL, dispatch_after = NULL,
             last_error = 'session_limit_exceeded'
         WHERE user_id = ? AND (? IS NULL OR lease_token = ?)`
      ).bind(userId, leaseToken, leaseToken).run();
      await setOperationStatus(env, operationId, userId, 'failed', undefined, 'session_limit_exceeded');
      message.ack();
      return;
    }
    await env.DB.prepare(
      `UPDATE github_session_sync_state
       SET lease_token = NULL, lease_expires_at = NULL, wake_enqueued = 0,
           wake_enqueued_at = NULL,
           dispatch_after = ?, last_error = 'github_sync_failed'
       WHERE user_id = ? AND (? IS NULL OR lease_token = ?)`
    ).bind(new Date(Date.now() + 60_000).toISOString(), userId, leaseToken, leaseToken).run();
    const terminal = message.attempts >= 5;
    await setOperationStatus(env, operationId, userId,
      terminal ? 'failed' : 'queued', undefined, terminal ? 'github_sync_failed' : undefined);
    if (terminal) {
      message.ack();
    } else {
      await dispatchGitHubSessionSync(env, userId);
      message.retry({ delaySeconds: Math.min(300, 2 ** message.attempts * 5) });
    }
  }
}
