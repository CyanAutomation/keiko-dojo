export type GitHubOperationType =
  | 'github-health'
  | 'log-doctor-scan'
  | 'log-doctor-fix'
  | 'github-sync-all';

export type GitHubOperationStatus = 'queued' | 'running' | 'completed' | 'failed';

export type GitHubOperationMessage = {
  kind: 'github-operation';
  jobId: string;
  userId: string;
};

export type GitHubOperationJob = {
  id: string;
  user_id: string;
  type: GitHubOperationType;
  status: GitHubOperationStatus;
  payload: string;
  result: string | null;
  error_message: string | null;
  attempts: number;
  created_at: string;
  updated_at: string;
};

type StatusUpdate = {
  result?: string | null;
  errorMessage?: string | null;
  completedAt?: 'now' | null;
  incrementAttempts?: boolean;
  onlyIfNotCompleted?: boolean;
  onlyIfActive?: boolean;
  onlyType?: GitHubOperationType;
};

export async function updateGitHubOperationStatus(
  env: Pick<Env, 'DB'>,
  operationId: string | undefined,
  userId: string,
  status: GitHubOperationStatus,
  update: StatusUpdate = {}
): Promise<void> {
  if (!operationId) return;

  const now = new Date().toISOString();
  const assignments = ['status = ?'];
  const values: (string | null)[] = [status];

  if ('result' in update) {
    assignments.push('result = ?');
    values.push(update.result ?? null);
  }
  if ('errorMessage' in update) {
    assignments.push('error_message = ?');
    values.push(update.errorMessage ?? null);
  }
  if (update.incrementAttempts) assignments.push('attempts = attempts + 1');
  assignments.push('updated_at = ?');
  values.push(now);
  if ('completedAt' in update) {
    assignments.push('completed_at = ?');
    values.push(update.completedAt === 'now' ? now : null);
  }

  const completionGuard = update.onlyIfNotCompleted ? " AND status != 'completed'" : '';
  const activeGuard = update.onlyIfActive ? " AND status IN ('queued', 'running')" : '';
  const typeGuard = update.onlyType ? ' AND type = ?' : '';
  await env.DB.prepare(
    `UPDATE github_operation_jobs SET ${assignments.join(', ')}
     WHERE id = ? AND user_id = ?${completionGuard}${activeGuard}${typeGuard}`
  ).bind(...values, operationId, userId, ...(update.onlyType ? [update.onlyType] : [])).run();
}

export async function updateGitHubSyncOperationStatus(
  env: Pick<Env, 'DB'>,
  operationId: string | undefined,
  userId: string,
  status: GitHubOperationStatus,
  result?: Record<string, unknown>,
  error?: string
): Promise<void> {
  await updateGitHubOperationStatus(env, operationId, userId, status, {
    result: result ? JSON.stringify(result) : null,
    errorMessage: error ?? null,
    incrementAttempts: status === 'running',
    completedAt: status === 'completed' || status === 'failed' ? 'now' : null,
    onlyType: 'github-sync-all',
  });
}
