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

  // Contract: openapi.yaml, POST /v1/github/health and /v1/github/log-doctor.
  it('rejects malformed branch-operation requests before queuing work', async () => {
    const userId = `invalid-branch-${crypto.randomUUID()}`;
    const send = vi.fn(async (_message: unknown, _options?: unknown) => {});
    const operationEnv = Object.assign(Object.create(testEnv), {
      BACKUP_QUEUE: { send },
    }) as Env;
    await env.DB.prepare(
      `INSERT INTO github_installations
       (user_id, installation_id, repository_owner, repository_name, repository_id, granted_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(userId, 813, 'CyanAutomation', 'branch-validation', 883, new Date().toISOString()).run();

    const invalidBodies = [
      { branch: '' },
      { branch: 'main', repository: 'another-repository' },
      { branch: 42 },
    ];

    try {
      for (const path of ['/v1/github/health', '/v1/github/log-doctor']) {
        for (const body of invalidBodies) {
          const response = await callOperation(path, userId, 'github:read', {
            method: 'POST', body: JSON.stringify(body),
          }, operationEnv);
          expect(response.status).toBe(400);
          expect(await response.json()).toMatchObject({ error: { code: 'bad_request' } });
        }
      }
      expect(send).not.toHaveBeenCalled();
      expect(await env.DB.prepare('SELECT id FROM github_operation_jobs WHERE user_id = ?').bind(userId).all())
        .toMatchObject({ results: [] });
    } finally {
      await env.DB.prepare('DELETE FROM github_operation_jobs WHERE user_id = ?').bind(userId).run();
      await env.DB.prepare('DELETE FROM github_installations WHERE user_id = ?').bind(userId).run();
    }
  });

  // Contract: openapi.yaml, POST /v1/github/health returns 400 for malformed requests.
  it('maps a malformed Content-Length to a public bad-request response', async () => {
    const response = await callOperation('/v1/github/health', `invalid-length-${crypto.randomUUID()}`, 'github:read', {
      method: 'POST',
      headers: { 'content-length': 'not-a-number' },
      body: '{}',
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: 'bad_request', message: 'Invalid JSON body' },
    });
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

  // Contract: docs/operations.md, GitHub Markdown sync; fixes must be path-safe and explicitly confirmed.
  it('rejects unsafe Log Doctor paths and requires explicit apply confirmation before queuing work', async () => {
    const userId = `github-fix-validation-${crypto.randomUUID()}`;
    const send = vi.fn(async (_message: unknown, _options?: unknown) => {});
    const operationEnv = Object.assign(Object.create(testEnv), {
      BACKUP_QUEUE: { send },
    }) as Env;
    await env.DB.prepare(
      `INSERT INTO github_installations
       (user_id, installation_id, repository_owner, repository_name, repository_id, granted_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(userId, 814, 'CyanAutomation', 'fix-validation', 884, new Date().toISOString()).run();

    try {
      const unsafePath = await callOperation('/v1/github/log-doctor/fix', userId, 'github:write', {
        method: 'POST', body: JSON.stringify({ mode: 'dry-run', paths: ['data/2026/10/../../secrets.md'] }),
      }, operationEnv);
      expect(unsafePath.status).toBe(400);
      expect(await unsafePath.json()).toMatchObject({ error: { code: 'bad_request' } });

      const unconfirmedApply = await callOperation('/v1/github/log-doctor/fix', userId, 'github:write', {
        method: 'POST', body: JSON.stringify({ mode: 'apply', paths: ['data/2026/10/20261024-matmetrics-session-1.md'] }),
      }, operationEnv);
      expect(unconfirmedApply.status).toBe(400);
      expect(await unconfirmedApply.json()).toMatchObject({ error: { code: 'bad_request' } });

      expect(send).not.toHaveBeenCalled();
      expect(await env.DB.prepare('SELECT id FROM github_operation_jobs WHERE user_id = ?').bind(userId).all())
        .toMatchObject({ results: [] });
    } finally {
      await env.DB.prepare('DELETE FROM github_operation_jobs WHERE user_id = ?').bind(userId).run();
      await env.DB.prepare('DELETE FROM github_installations WHERE user_id = ?').bind(userId).run();
    }
  });

  it('rejects invalid Log Doctor options, duplicate paths, and malformed branches', async () => {
    const userId = `github-fix-shape-${crypto.randomUUID()}`;
    const send = vi.fn(async (_message: unknown, _options?: unknown) => {});
    const operationEnv = Object.assign(Object.create(testEnv), {
      BACKUP_QUEUE: { send },
    }) as Env;
    await env.DB.prepare(
      `INSERT INTO github_installations
       (user_id, installation_id, repository_owner, repository_name, repository_id, granted_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(userId, 815, 'CyanAutomation', 'fix-shape', 885, new Date().toISOString()).run();

    const path = 'data/2026/10/20261024-matmetrics-session-1.md';
    const invalidBodies = [
      { mode: 'dry-run', paths: [path, path] },
      { mode: 'dry-run', paths: [path], options: { preserveUserContent: false } },
      { mode: 'dry-run', paths: [path], options: { unexpected: true } },
      { mode: 'dry-run', paths: [path], branch: '  ' },
      { mode: 'dry-run', paths: [path], branch: 'feature\u0000branch' },
      { mode: 'dry-run', paths: [path], extra: true },
      { mode: 'unknown', paths: [path] },
    ];

    try {
      for (const body of invalidBodies) {
        const response = await callOperation('/v1/github/log-doctor/fix', userId, 'github:write', {
          method: 'POST', body: JSON.stringify(body),
        }, operationEnv);
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ error: { code: 'bad_request' } });
      }
      expect(send).not.toHaveBeenCalled();
      expect(await env.DB.prepare('SELECT id FROM github_operation_jobs WHERE user_id = ?').bind(userId).all())
        .toMatchObject({ results: [] });
    } finally {
      await env.DB.prepare('DELETE FROM github_operation_jobs WHERE user_id = ?').bind(userId).run();
      await env.DB.prepare('DELETE FROM github_installations WHERE user_id = ?').bind(userId).run();
    }
  });
});
