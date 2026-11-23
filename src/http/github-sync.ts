import type { GitHubSessionSyncMessage } from '../application/github-session-sync-queue';
import { dispatchGitHubSessionSync } from '../application/github-session-sync-queue';
import type { GitHubInstallation } from '../domain/github-installation';
import {
  githubSessionMarkdownPathForRow,
  isKeikoSessionMarkdownPath,
  listSelectedGitHubSessionMarkdownPaths,
  syncGitHubSessionMarkdown,
  type GitHubSessionRow,
} from '../integrations/github-app';

type SyncState = {
  user_id: string;
  repository_id: number;
  generation: number;
  full_sync_required: number;
  full_sync_cursor: number;
  full_sync_cursor_generation: number | null;
  full_sync_delete_cursor: string | null;
  full_sync_tree_sha: string | null;
  next_sync_at: string;
  wake_enqueued: number;
  lease_token: string | null;
};
type SyncItem = { session_id: string; generation: number };
type SyncedFile = { session_id: string; path: string; revision: number };

const MAX_SYNC_ITEMS_PER_BATCH = 10;
const MAX_FULL_SYNC_DELETIONS_PER_BATCH = 10;
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
  removedIds: string[]
): Promise<void> {
  const statements: D1PreparedStatement[] = [];
  for (const sessionId of removedIds) {
    statements.push(env.DB.prepare(
      'DELETE FROM github_synced_session_files WHERE user_id = ? AND repository_id = ? AND session_id = ?'
    ).bind(userId, repositoryId, sessionId));
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

type SyncBatch = {
  fullSync: boolean;
  rows: GitHubSessionRow[];
  items: SyncItem[];
  deletePaths: string[];
  deleteFileShas: Map<string, string>;
  fullSyncCursor: number;
  fullSyncDeleteCursor: string | null;
  fullSyncTreeSha: string | null;
  hasMoreFullSync: boolean;
};

async function loadSyncBatch(
  env: Env,
  userId: string,
  installation: GitHubInstallation,
  generation: number,
  fullSync: boolean,
  fullSyncCursor: number,
  fullSyncDeleteCursor: string | null,
  fullSyncTreeSha: string | null
): Promise<SyncBatch | null> {
  if (fullSync) {
    const result = await env.DB.prepare(
      `SELECT id, session_date, category, effort, payload, revision, updated_at
       FROM sessions WHERE user_id = ? ORDER BY session_date DESC, id DESC LIMIT ?`
    ).bind(userId, MAX_FULL_SYNC_SESSIONS + 1).all<GitHubSessionRow>();
    const allRows = result.results;
    if (allRows.length > MAX_FULL_SYNC_SESSIONS) throw new FullSyncSessionLimitError();
    const cursor = Math.min(fullSyncCursor, allRows.length);
    const rows = allRows.slice(cursor, cursor + MAX_SYNC_ITEMS_PER_BATCH);
    const expectedPaths = new Set(allRows.map(githubSessionMarkdownPathForRow));
    const remote = await listSelectedGitHubSessionMarkdownPaths(env, installation);
    const staleFiles = remote.files.filter((file) =>
      isKeikoSessionMarkdownPath(file.path) && !expectedPaths.has(file.path)
    );
    const activeDeleteCursor = fullSyncTreeSha === remote.treeSha ? fullSyncDeleteCursor : null;
    const staleFilesAfterCursor = activeDeleteCursor
      ? staleFiles.filter((file) => file.path.localeCompare(activeDeleteCursor) > 0)
      : staleFiles;
    const filesToDelete = staleFilesAfterCursor.slice(0, MAX_FULL_SYNC_DELETIONS_PER_BATCH);
    return {
      fullSync: true,
      rows,
      items: [],
      deletePaths: filesToDelete.map((file) => file.path),
      deleteFileShas: new Map(filesToDelete.map((file) => [file.path, file.sha])),
      fullSyncCursor: cursor + rows.length,
      fullSyncDeleteCursor: filesToDelete.at(-1)?.path ?? activeDeleteCursor,
      fullSyncTreeSha: remote.treeSha,
      hasMoreFullSync: cursor + rows.length < allRows.length ||
        staleFilesAfterCursor.length > filesToDelete.length,
    };
  }

  const pendingItems = await env.DB.prepare(
    `SELECT session_id, generation FROM github_session_sync_items
     WHERE user_id = ? AND generation <= ?
     ORDER BY generation, session_id LIMIT ?`
  ).bind(userId, generation, MAX_SYNC_ITEMS_PER_BATCH).all<SyncItem>();
  const items = pendingItems.results;
  if (!items.length) return null;

  const ids = items.map((item) => item.session_id);
  const rows = await rowsForIds(env, userId, ids);
  const idList = ids.map(() => '?').join(', ');
  const mapped = await env.DB.prepare(
    `SELECT session_id, path, revision FROM github_synced_session_files
     WHERE user_id = ? AND repository_id = ? AND session_id IN (${idList})`
  ).bind(userId, installation.repository_id, ...ids).all<SyncedFile>();
  const nextPaths = new Map(rows.map((row) => [row.id, githubSessionMarkdownPathForRow(row)]));
  return {
    fullSync: false,
    rows,
    items,
    deletePaths: mapped.results
      .filter((file) => nextPaths.get(file.session_id) !== file.path)
      .map((file) => file.path),
    deleteFileShas: new Map(),
    fullSyncCursor: 0,
    fullSyncDeleteCursor: null,
    fullSyncTreeSha: null,
    hasMoreFullSync: false,
  };
}

async function clearProcessedItems(
  env: Env,
  userId: string,
  generation: number,
  batch: SyncBatch
): Promise<void> {
  const statements: D1PreparedStatement[] = [];
  if (batch.fullSync && !batch.hasMoreFullSync) {
    statements.push(env.DB.prepare(
      'DELETE FROM github_session_sync_items WHERE user_id = ? AND generation <= ?'
    ).bind(userId, generation));
  } else {
    for (const item of batch.items) {
      statements.push(env.DB.prepare(
        `DELETE FROM github_session_sync_items
         WHERE user_id = ? AND session_id = ? AND generation = ?`
      ).bind(userId, item.session_id, item.generation));
    }
  }
  if (statements.length) await env.DB.batch(statements);
}

async function syncAndPersistBatch(
  env: Env,
  userId: string,
  installation: GitHubInstallation,
  generation: number,
  batch: SyncBatch
): Promise<Array<{ id: string; path: string; revision: number }>> {
  const synced = await syncGitHubSessionMarkdown(
    env, installation, batch.rows, batch.deletePaths, batch.deleteFileShas
  );
  const syncedById = new Map(synced.map((file) => [file.id, file]));
  const removedIds = batch.fullSync
    ? []
    : batch.items.filter((item) => !syncedById.has(item.session_id)).map((item) => item.session_id);
  await upsertSyncedFiles(env, userId, installation.repository_id,
    synced.map((file) => ({ session_id: file.id, path: file.path, revision: file.revision })),
    removedIds);
  if (batch.fullSync && !batch.hasMoreFullSync) {
    await env.DB.prepare(
      `DELETE FROM github_synced_session_files
       WHERE user_id = ? AND repository_id = ?
         AND NOT EXISTS (
           SELECT 1 FROM sessions
           WHERE sessions.user_id = github_synced_session_files.user_id
             AND sessions.id = github_synced_session_files.session_id
         )`
    ).bind(userId, installation.repository_id).run();
  }
  await clearProcessedItems(env, userId, generation, batch);
  return synced;
}

async function finalizeSync(
  env: Env,
  userId: string,
  generation: number,
  leaseToken: string
): Promise<boolean> {
  const completedAt = new Date().toISOString();
  const finalized = await env.DB.prepare(
    `UPDATE github_session_sync_state
     SET completed_generation = ?, full_sync_required = 0, last_synced_at = ?, last_error = NULL,
         full_sync_cursor = 0, full_sync_cursor_generation = NULL,
         full_sync_delete_cursor = NULL, full_sync_tree_sha = NULL,
         wake_enqueued = 0, wake_enqueued_at = NULL,
         lease_token = NULL, lease_expires_at = NULL, dispatch_after = NULL
     WHERE user_id = ? AND generation = ? AND lease_token = ?
       AND NOT EXISTS (SELECT 1 FROM github_session_sync_items WHERE user_id = ?)`
  ).bind(generation, completedAt, userId, generation, leaseToken, userId).run();

  if (finalized.meta.changes === 1) return true;
  await env.DB.prepare(
    `UPDATE github_session_sync_state
     SET lease_token = NULL, lease_expires_at = NULL, wake_enqueued = 0,
         wake_enqueued_at = NULL, dispatch_after = NULL
     WHERE user_id = ? AND lease_token = ?`
  ).bind(userId, leaseToken).run();
  return false;
}

async function enqueueFullSyncContinuation(
  env: Env,
  userId: string,
  generation: number,
  leaseToken: string,
  cursor: number,
  deleteCursor: string | null,
  treeSha: string,
  operationId: string | undefined
): Promise<boolean> {
  const advanced = await env.DB.prepare(
    `UPDATE github_session_sync_state
     SET full_sync_cursor = ?, full_sync_cursor_generation = ?,
         full_sync_delete_cursor = ?, full_sync_tree_sha = ?,
         lease_token = NULL, lease_expires_at = NULL,
         wake_enqueued = 0, wake_enqueued_at = NULL, dispatch_after = NULL
     WHERE user_id = ? AND generation = ? AND lease_token = ? AND full_sync_required = 1`
  ).bind(cursor, generation, deleteCursor, treeSha, userId, generation, leaseToken).run();
  if (advanced.meta.changes !== 1) {
    await env.DB.prepare(
      `UPDATE github_session_sync_state
       SET lease_token = NULL, lease_expires_at = NULL, wake_enqueued = 0,
           wake_enqueued_at = NULL, dispatch_after = NULL
       WHERE user_id = ? AND lease_token = ?`
    ).bind(userId, leaseToken).run();
  }
  await setOperationStatus(env, operationId, userId, 'queued');
  return dispatchGitHubSessionSync(env, userId, {
    immediate: true,
    operationId,
    force: true,
  });
}

async function handleSyncFailure(
  error: unknown,
  env: Env,
  message: Message<GitHubSessionSyncMessage>,
  userId: string,
  operationId: string | undefined,
  leaseToken: string | null
): Promise<void> {
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

type SyncContext = { installation: GitHubInstallation | null; state: SyncState | null };
type PreparedSync = {
  installation: GitHubInstallation;
  repositoryId: number;
  generation: number;
  fullSync: boolean;
  fullSyncCursor: number;
  fullSyncDeleteCursor: string | null;
  fullSyncTreeSha: string | null;
  leaseToken: string;
};

async function readSyncContext(env: Env, userId: string): Promise<SyncContext> {
  const installation = await env.DB.prepare(
    `SELECT user_id, installation_id, repository_owner, repository_name, repository_id
     FROM github_installations WHERE user_id = ? AND revoked_at IS NULL`
  ).bind(userId).first<GitHubInstallation>();
  const state = await env.DB.prepare(
    `SELECT user_id, repository_id, generation, full_sync_required, next_sync_at,
       full_sync_cursor, full_sync_cursor_generation, full_sync_delete_cursor,
       full_sync_tree_sha, wake_enqueued, lease_token
     FROM github_session_sync_state WHERE user_id = ?`
  ).bind(userId).first<SyncState>();
  return { installation, state };
}

async function handleMissingSyncContext(
  env: Env,
  message: Message<GitHubSessionSyncMessage>,
  userId: string,
  operationId: string | undefined,
  installation: GitHubInstallation | null
): Promise<void> {
  if (operationId) {
    await setOperationStatus(env, operationId, userId, 'failed', undefined,
      installation ? 'sync_state_missing' : 'github_connection_missing');
  }
  message.ack();
}

async function deferSyncUntilDue(
  env: Env,
  message: Message<GitHubSessionSyncMessage>,
  userId: string
): Promise<void> {
  await env.DB.prepare(
    `UPDATE github_session_sync_state SET wake_enqueued = 0, wake_enqueued_at = NULL
     WHERE user_id = ? AND lease_token IS NULL`
  ).bind(userId).run();
  message.ack();
  await dispatchGitHubSessionSync(env, userId);
}

async function handleUnavailableLease(
  env: Env,
  message: Message<GitHubSessionSyncMessage>,
  userId: string,
  operationId: string | undefined
): Promise<void> {
  if (operationId) {
    await setOperationStatus(env, operationId, userId, 'queued');
    message.retry({ delaySeconds: 15 });
    return;
  }
  message.ack();
}

async function prepareSync(
  env: Env,
  message: Message<GitHubSessionSyncMessage>,
  now: Date,
  userId: string,
  operationId: string | undefined,
  leaseRef: { token: string | null }
): Promise<PreparedSync | null> {
  const { installation, state } = await readSyncContext(env, userId);
  if (!installation || !state) {
    await handleMissingSyncContext(env, message, userId, operationId, installation);
    return null;
  }
  if (Date.parse(state.next_sync_at) > now.getTime() && !operationId) {
    await deferSyncUntilDue(env, message, userId);
    return null;
  }

  const leaseToken = crypto.randomUUID();
  leaseRef.token = leaseToken;
  const leaseExpiresAt = new Date(now.getTime() + LEASE_SECONDS * 1000).toISOString();
  const claimed = await env.DB.prepare(
    `UPDATE github_session_sync_state SET lease_token = ?, lease_expires_at = ?
     WHERE user_id = ? AND repository_id = ? AND generation = ?
       AND (lease_token IS NULL OR lease_expires_at <= ?)
     RETURNING generation, full_sync_required, full_sync_cursor, full_sync_cursor_generation,
       full_sync_delete_cursor, full_sync_tree_sha`
  ).bind(leaseToken, leaseExpiresAt, userId, state.repository_id,
    state.generation, now.toISOString()).first<{
      generation: number;
      full_sync_required: number;
      full_sync_cursor: number;
      full_sync_cursor_generation: number | null;
      full_sync_delete_cursor: string | null;
      full_sync_tree_sha: string | null;
    }>();
  if (!claimed) {
    await handleUnavailableLease(env, message, userId, operationId);
    return null;
  }
  return {
    installation,
    repositoryId: state.repository_id,
    generation: claimed.generation,
    fullSync: claimed.full_sync_required === 1,
    fullSyncCursor: claimed.full_sync_cursor_generation === claimed.generation
      ? claimed.full_sync_cursor
      : 0,
    fullSyncDeleteCursor: claimed.full_sync_cursor_generation === claimed.generation
      ? claimed.full_sync_delete_cursor
      : null,
    fullSyncTreeSha: claimed.full_sync_cursor_generation === claimed.generation
      ? claimed.full_sync_tree_sha
      : null,
    leaseToken,
  };
}

export async function processGitHubSessionSyncMessage(
  message: Message<GitHubSessionSyncMessage>,
  env: Env
): Promise<void> {
  const { userId, operationId } = message.body;
  const now = new Date();
  const leaseRef = { token: null as string | null };

  try {
    const prepared = await prepareSync(env, message, now, userId, operationId, leaseRef);
    if (!prepared) return;
    await setOperationStatus(env, operationId, userId, 'running');
    if (prepared.installation.repository_id !== prepared.repositoryId) {
      throw new Error('GitHub repository changed during sync');
    }

    const batch = await loadSyncBatch(
      env,
      userId,
      prepared.installation,
      prepared.generation,
      prepared.fullSync,
      prepared.fullSyncCursor,
      prepared.fullSyncDeleteCursor,
      prepared.fullSyncTreeSha
    );
    if (!batch) {
      await completeNoop(env, userId, operationId, prepared.generation, prepared.leaseToken);
      message.ack();
      return;
    }

    const synced = await syncAndPersistBatch(env, userId, prepared.installation, prepared.generation, batch);
    if (prepared.fullSync && batch.hasMoreFullSync) {
      const enqueued = await enqueueFullSyncContinuation(
        env,
        userId,
        prepared.generation,
        prepared.leaseToken,
        batch.fullSyncCursor,
        batch.fullSyncDeleteCursor,
        batch.fullSyncTreeSha!,
        operationId
      );
      if (enqueued) message.ack();
      else message.retry({ delaySeconds: 60 });
      return;
    }

    const completed = await finalizeSync(env, userId, prepared.generation, prepared.leaseToken);
    if (completed) {
      const manifest = await env.DB.prepare(
        `SELECT COUNT(*) AS session_count FROM github_synced_session_files
         WHERE user_id = ? AND repository_id = ?`
      ).bind(userId, prepared.repositoryId).first<{ session_count: number }>();
      const sessionCount = manifest?.session_count ?? synced.length;
      await setOperationStatus(env, operationId, userId, 'completed', {
        success: true,
        message: `Synced ${sessionCount} training session(s) to GitHub Markdown.`,
        sessionCount,
      });
    } else {
      await setOperationStatus(env, operationId, userId, 'queued');
      await dispatchGitHubSessionSync(env, userId, { operationId });
    }
    message.ack();
  } catch (error) {
    await handleSyncFailure(error, env, message, userId, operationId, leaseRef.token);
  }
}
