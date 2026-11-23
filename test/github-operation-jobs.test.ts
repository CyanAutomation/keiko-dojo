import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { updateGitHubOperationStatus } from '../src/application/github-operation-jobs';

describe('GitHub operation job status updates', () => {
  it('scopes sync status changes to sync-all jobs and preserves their lifecycle fields', async () => {
    const userId = `operation-status-${crypto.randomUUID()}`;
    const syncJobId = crypto.randomUUID();
    const otherJobId = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const insertJob = (id: string, type: string) => env.DB.prepare(
      `INSERT INTO github_operation_jobs
       (id, user_id, type, status, payload, attempts, created_at, updated_at)
       VALUES (?, ?, ?, 'queued', '{}', 0, ?, ?)`
    ).bind(id, userId, type, createdAt, createdAt);

    await env.DB.batch([
      insertJob(syncJobId, 'github-sync-all'),
      insertJob(otherJobId, 'github-health'),
    ]);

    try {
      await updateGitHubOperationStatus(env, otherJobId, userId, 'running', {
        incrementAttempts: true,
        onlyType: 'github-sync-all',
      });
      expect(await env.DB.prepare(
        'SELECT status, attempts FROM github_operation_jobs WHERE id = ?'
      ).bind(otherJobId).first()).toMatchObject({ status: 'queued', attempts: 0 });

      await updateGitHubOperationStatus(env, syncJobId, userId, 'running', {
        result: null,
        errorMessage: null,
        incrementAttempts: true,
        completedAt: null,
        onlyType: 'github-sync-all',
      });
      expect(await env.DB.prepare(
        'SELECT status, attempts, error_message, completed_at FROM github_operation_jobs WHERE id = ?'
      ).bind(syncJobId).first()).toMatchObject({
        status: 'running',
        attempts: 1,
        error_message: null,
        completed_at: null,
      });

      await updateGitHubOperationStatus(env, syncJobId, userId, 'completed', {
        result: JSON.stringify({ success: true }),
        errorMessage: null,
        completedAt: 'now',
        onlyType: 'github-sync-all',
      });
      const completed = await env.DB.prepare(
        'SELECT status, result, error_message, completed_at FROM github_operation_jobs WHERE id = ?'
      ).bind(syncJobId).first<{ status: string; result: string | null; error_message: string | null; completed_at: string | null }>();
      expect(completed).toMatchObject({
        status: 'completed',
        result: '{"success":true}',
        error_message: null,
      });
      expect(completed?.completed_at).toBeTruthy();
    } finally {
      await env.DB.prepare('DELETE FROM github_operation_jobs WHERE user_id = ?').bind(userId).run();
    }
  });
});
