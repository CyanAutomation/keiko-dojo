import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { handleBackupRequest } from '../src/http/backups';
import { createApiHarness } from './api-harness';

const { testEnv, tokenFor } = createApiHarness();

describe('backup HTTP routes', () => {
  it('returns an invalid GitHub installation callback to the configured frontend', async () => {
    const callbackEnv = Object.assign(Object.create(testEnv), {
      ENVIRONMENT: 'production',
      MATMETRICS_FRONTEND_URL: 'https://matmetrics.example.test',
    }) as Env;
    const response = await handleBackupRequest(
      new Request('https://keiko.example.test/v1/backups/github-installation/callback?state=invalid'),
      callbackEnv,
      'backup-callback-test'
    );

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('location')!);
    expect(location.origin).toBe(callbackEnv.MATMETRICS_FRONTEND_URL);
    expect(location.pathname).toBe('/');
    expect(location.searchParams.get('githubBackup')).toBe('failed');
  });

  // Contract: openapi.yaml, GET /v1/backups/status; status and installation are subject-scoped.
  it('scopes backup status to the authenticated user and required permission', async () => {
    const userId = `backup-user-${crypto.randomUUID()}`;
    const otherUserId = `${userId}-other`;
    const now = '2026-10-26T12:00:00.000Z';
    const currentNextSyncAt = '2026-10-26T12:01:00.000Z';
    const otherNextSyncAt = '2026-10-26T12:02:00.000Z';
    const currentOwner = 'current-owner';
    const currentRepository = 'current-repository';
    const otherOwner = 'other-owner';
    const otherRepository = 'other-repository';

    try {
      for (const [owner, repository, installationId, repositoryId, subject, nextSyncAt, lastSyncedAt, lastError] of [
        [currentOwner, currentRepository, 811, 881, userId, currentNextSyncAt, '2026-10-26T11:00:00.000Z', 'current-error'],
        [otherOwner, otherRepository, 812, 882, otherUserId, otherNextSyncAt, '2026-10-26T10:00:00.000Z', 'other-error'],
      ] as const) {
        await env.DB.prepare(
          `INSERT INTO github_installations
           (user_id, installation_id, repository_owner, repository_name, repository_id, granted_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).bind(subject, installationId, owner, repository, repositoryId, now).run();
        await env.DB.prepare(
          `INSERT INTO github_session_sync_state
           (user_id, repository_id, generation, completed_generation, full_sync_required,
            next_sync_at, last_synced_at, last_error)
           VALUES (?, ?, 2, 1, 0, ?, ?, ?)`
        ).bind(subject, repositoryId, nextSyncAt, lastSyncedAt, lastError).run();
        await env.DB.prepare(
          `INSERT INTO github_session_sync_items (user_id, session_id, generation)
           VALUES (?, ?, 2)`
        ).bind(subject, `${subject}-session`).run();
      }

      const unauthorizedToken = await tokenFor(userId, { scope: 'sessions:read' });
      const unauthorized = await handleBackupRequest(
        new Request('https://keiko.example.test/v1/backups/status', {
          headers: { authorization: `Bearer ${unauthorizedToken}` },
        }),
        testEnv,
        'backup-status-forbidden'
      );
      expect(unauthorized.status).toBe(403);

      const statusToken = await tokenFor(userId, { scope: 'backups:read' });
      const response = await handleBackupRequest(
        new Request('https://keiko.example.test/v1/backups/status', {
          headers: { authorization: `Bearer ${statusToken}` },
        }),
        testEnv,
        'backup-status-owner'
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        configured: true,
        installation: { owner: currentOwner, repository: currentRepository },
        pending: true,
        nextSyncAt: currentNextSyncAt,
        lastSyncedAt: '2026-10-26T11:00:00.000Z',
        error: 'current-error',
      });

      await env.DB.batch([
        env.DB.prepare('DELETE FROM github_session_sync_items WHERE user_id = ?').bind(userId),
        env.DB.prepare(
          `UPDATE github_session_sync_state SET completed_generation = generation,
           full_sync_required = 0, last_error = NULL WHERE user_id = ?`
        ).bind(userId),
      ]);
      const idleResponse = await handleBackupRequest(
        new Request('https://keiko.example.test/v1/backups/status', {
          headers: { authorization: `Bearer ${statusToken}` },
        }),
        testEnv,
        'backup-status-idle'
      );
      expect(await idleResponse.json()).toEqual({
        configured: true,
        installation: { owner: currentOwner, repository: currentRepository },
        pending: false,
        nextSyncAt: null,
        lastSyncedAt: '2026-10-26T11:00:00.000Z',
        error: null,
      });
    } finally {
      await env.DB.batch([
        env.DB.prepare('DELETE FROM github_session_sync_items WHERE user_id IN (?, ?)').bind(userId, otherUserId),
        env.DB.prepare('DELETE FROM github_session_sync_state WHERE user_id IN (?, ?)').bind(userId, otherUserId),
        env.DB.prepare('DELETE FROM github_installations WHERE user_id IN (?, ?)').bind(userId, otherUserId),
      ]);
    }
  });

  it('keeps removed D1 restore endpoints unavailable', async () => {
    const response = await handleBackupRequest(
      new Request('https://keiko.example.test/v1/backups/snapshot-id/restore', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirm: true }),
      }),
      testEnv,
      'backup-restore-removed'
    );
    expect(response.status).toBe(405);
    const tables = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('backup_snapshots', 'restore_activity', 'backup_jobs')"
    ).all<{ name: string }>();
    expect(tables.results).toEqual([]);
  });
});
