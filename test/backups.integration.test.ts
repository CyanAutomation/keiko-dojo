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

  it('scopes backup status to the authenticated user and required permission', async () => {
    const userId = `backup-user-${crypto.randomUUID()}`;
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
    expect(await response.json()).toMatchObject({
      configured: false,
      pending: false,
      lastSyncedAt: null,
    });
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
