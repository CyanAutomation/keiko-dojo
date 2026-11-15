import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { handleGitHubOperationRequest } from '../src/http/github-operations';
import { createApiHarness } from './api-harness';

const { testEnv, tokenFor } = createApiHarness();

async function callOperation(
  path: string,
  userId: string,
  scope: string,
  init: RequestInit = {},
  requestEnv: Env = testEnv
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${await tokenFor(userId, { scope })}`);
  if (init.body !== undefined) headers.set('content-type', 'application/json');
  return handleGitHubOperationRequest(
    new Request(`https://keiko.example.test${path}`, { ...init, headers, body: init.body }),
    requestEnv,
    `github-operation-${crypto.randomUUID()}`
  );
}

describe('GitHub operation routes', () => {
  it('queues selected-repository operations and scopes job access to the owner', async () => {
    const userId = `github-operation-${crypto.randomUUID()}`;
    await env.DB.prepare(
      `INSERT INTO github_installations
       (user_id, installation_id, repository_owner, repository_name, repository_id, granted_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(userId, 731, 'CyanAutomation', 'matmetrics', 88, new Date().toISOString()).run();

    try {
      const arbitraryRepository = await callOperation('/v1/github/health', userId, 'github:read', {
        method: 'POST', body: JSON.stringify({ owner: 'attacker', repo: 'elsewhere' }),
      });
      expect(arbitraryRepository.status).toBe(400);

      const queued = await callOperation('/v1/github/health', userId, 'github:read', {
        method: 'POST', body: '{}',
      });
      expect(queued.status).toBe(202);
      const job = await queued.json() as { id: string; type: string; status: string };
      expect(job).toMatchObject({ type: 'github-health', status: 'queued' });

      const anotherUser = await callOperation(`/v1/github/jobs/${job.id}`, `${userId}-other`, 'github:read');
      expect(anotherUser.status).toBe(404);
      const owner = await callOperation(`/v1/github/jobs/${job.id}`, userId, 'github:read');
      expect(owner.status).toBe(200);
      expect(await owner.json()).toMatchObject({ id: job.id, type: 'github-health', status: 'queued' });
    } finally {
      await env.DB.prepare('DELETE FROM github_operation_jobs WHERE user_id = ?').bind(userId).run();
      await env.DB.prepare('DELETE FROM github_installations WHERE user_id = ?').bind(userId).run();
    }
  });

  it('rejects malformed branch-operation requests before queuing work', async () => {
    const invalidBodies = [
      { branch: '' },
      { branch: 'main', repository: 'another-repository' },
      { branch: 42 },
    ];

    for (const path of ['/v1/github/health', '/v1/github/log-doctor']) {
      for (const body of invalidBodies) {
        const response = await callOperation(path, `invalid-branch-${crypto.randomUUID()}`, 'github:read', {
          method: 'POST', body: JSON.stringify(body),
        });
        expect(response.status).toBe(400);
      }
    }
  });

  it('queues a full Markdown sync without creating a D1 snapshot job', async () => {
    const userId = `github-sync-${crypto.randomUUID()}`;
    await env.DB.prepare(
      `INSERT INTO github_installations
       (user_id, installation_id, repository_owner, repository_name, repository_id, granted_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(userId, 732, 'CyanAutomation', 'matmetrics', 88, new Date().toISOString()).run();
    const send = vi.fn(async (_message: unknown, _options?: unknown) => {});
    const operationEnv = Object.assign(Object.create(testEnv), {
      BACKUP_QUEUE: { send },
    }) as Env;

    try {
      const response = await callOperation('/v1/github/sync-all', userId, 'github:write', {
        method: 'POST', body: '{}',
      }, operationEnv);
      expect(response.status).toBe(202);
      const job = await response.json() as { id: string; type: string; status: string };
      expect(job).toMatchObject({ type: 'github-sync-all', status: 'queued' });
      expect(send).toHaveBeenCalledWith(
        { kind: 'github-session-sync', userId, operationId: job.id },
        { delaySeconds: 0 }
      );
      expect(await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'backup_snapshots'").first())
        .toBeNull();
      expect(await env.DB.prepare('SELECT type, status FROM github_operation_jobs WHERE id = ?').bind(job.id).first())
        .toMatchObject({ type: 'github-sync-all', status: 'queued' });
    } finally {
      await env.DB.prepare('DELETE FROM github_operation_jobs WHERE user_id = ?').bind(userId).run();
      await env.DB.prepare('DELETE FROM github_session_sync_state WHERE user_id = ?').bind(userId).run();
      await env.DB.prepare('DELETE FROM github_installations WHERE user_id = ?').bind(userId).run();
    }
  });

  it('rejects unsafe Log Doctor paths and requires explicit apply confirmation', async () => {
    const userId = `github-fix-validation-${crypto.randomUUID()}`;
    const unsafePath = await callOperation('/v1/github/log-doctor/fix', userId, 'github:write', {
      method: 'POST', body: JSON.stringify({ mode: 'dry-run', paths: ['data/2026/10/../../secrets.md'] }),
    });
    expect(unsafePath.status).toBe(400);

    const unconfirmedApply = await callOperation('/v1/github/log-doctor/fix', userId, 'github:write', {
      method: 'POST', body: JSON.stringify({ mode: 'apply', paths: ['data/2026/10/20261024-matmetrics-session-1.md'] }),
    });
    expect(unconfirmedApply.status).toBe(400);
  });
});
