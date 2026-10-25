const DISPATCH_RETRY_SECONDS = 60;

export type GitHubSessionSyncMessage = {
  kind: 'github-session-sync';
  userId: string;
  operationId?: string;
};

export async function dispatchGitHubSessionSync(
  env: Env,
  userId: string,
  options: { immediate?: boolean; operationId?: string; force?: boolean } = {}
): Promise<boolean> {
  const now = new Date();
  const nowIso = now.toISOString();
  const state = options.force
    ? await env.DB.prepare(
        `UPDATE github_session_sync_state SET wake_enqueued = 1, wake_enqueued_at = ?, dispatch_after = NULL
         WHERE user_id = ? AND EXISTS (
           SELECT 1 FROM github_installations
           WHERE user_id = ? AND revoked_at IS NULL
         )
         RETURNING next_sync_at`
      ).bind(nowIso, userId, userId).first<{ next_sync_at: string }>()
    : await env.DB.prepare(
        `UPDATE github_session_sync_state SET wake_enqueued = 1, wake_enqueued_at = ?, dispatch_after = NULL
         WHERE user_id = ? AND wake_enqueued = 0
           AND (dispatch_after IS NULL OR dispatch_after <= ?)
           AND EXISTS (
             SELECT 1 FROM github_installations
             WHERE user_id = ? AND revoked_at IS NULL
           )
         RETURNING next_sync_at`
      ).bind(nowIso, userId, nowIso, userId).first<{ next_sync_at: string }>();

  if (!state) return false;
  const dueAt = Date.parse(state.next_sync_at);
  const delaySeconds = options.immediate
    ? 0
    : Math.max(0, Math.ceil((dueAt - now.getTime()) / 1000));
  const message: GitHubSessionSyncMessage = {
    kind: 'github-session-sync',
    userId,
    ...(options.operationId ? { operationId: options.operationId } : {}),
  };

  try {
    await env.BACKUP_QUEUE.send(message, { delaySeconds });
    return true;
  } catch {
    const dispatchAfter = new Date(Date.now() + DISPATCH_RETRY_SECONDS * 1000).toISOString();
    await env.DB.prepare(
      `UPDATE github_session_sync_state
       SET wake_enqueued = 0, wake_enqueued_at = NULL,
           dispatch_after = ?, last_error = 'queue_unavailable'
       WHERE user_id = ?`
    ).bind(dispatchAfter, userId).run();
    return false;
  }
}

export async function dispatchPendingGitHubSessionSyncs(env: Env): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE github_session_sync_state
     SET lease_token = NULL, lease_expires_at = NULL, wake_enqueued = 0,
         wake_enqueued_at = NULL, dispatch_after = NULL
     WHERE lease_expires_at IS NOT NULL AND lease_expires_at <= ?`
  ).bind(now).run();
  const staleWakeBefore = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  await env.DB.prepare(
    `UPDATE github_session_sync_state
     SET wake_enqueued = 0, wake_enqueued_at = NULL
     WHERE wake_enqueued = 1 AND wake_enqueued_at <= ?
       AND (lease_expires_at IS NULL OR lease_expires_at <= ?)`
  ).bind(staleWakeBefore, now).run();
  const pending = await env.DB.prepare(
    `SELECT state.user_id FROM github_session_sync_state AS state
     INNER JOIN github_installations AS installation ON installation.user_id = state.user_id
     WHERE installation.revoked_at IS NULL
       AND state.wake_enqueued = 0
       AND (state.dispatch_after IS NULL OR state.dispatch_after <= ?)
       AND (state.lease_expires_at IS NULL OR state.lease_expires_at <= ?)
       AND state.next_sync_at <= ?
     ORDER BY state.next_sync_at LIMIT 100`
  ).bind(now, now, now).all<{ user_id: string }>();

  for (const { user_id: userId } of pending.results) {
    await dispatchGitHubSessionSync(env, userId);
  }
}
