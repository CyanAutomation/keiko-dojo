import { env } from 'cloudflare:workers';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { authenticateRequest } from '../src/auth/bearer-auth';
import worker from '../src/index';
import { processBackupMessage } from '../src/http/backups';

const issuer = 'https://auth.example.test';
const jwksUrl = `${issuer}/api/auth/jwks`;
const audience = 'keiko-dojo-api';
const keyId = 'keiko-test-key';
const allowRateLimit = { limit: async (_input: { key: string }) => ({ success: true }) };
const testEnv = Object.assign(Object.create(env), {
  SESSION_READ_LIMITER: allowRateLimit,
  SESSION_WRITE_LIMITER: allowRateLimit,
  BACKUP_WRITE_LIMITER: allowRateLimit,
}) as Env;
const testSession = {
  id: 'test-session-1',
  date: '2026-10-16',
  techniques: ['Uchi mata', 'O soto gari'],
  effort: 4,
  category: 'Technical',
  description: 'Grip fighting and entries',
  notes: 'Good pace',
  duration: 90,
};

let privateKey: CryptoKey;
let publicJwk: JWK;
let originalFetch: typeof fetch;

async function tokenFor(
  userId: string,
  options: {
    aud?: string;
    scope?: string;
    expired?: boolean;
    issuedAtOffsetSeconds?: number;
  } = {}
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const issuedAt = options.expired
    ? now - 600
    : now + (options.issuedAtOffsetSeconds ?? 0);
  return new SignJWT({
    appUserId: userId,
    scope: options.scope ?? 'sessions:read sessions:write',
  })
    .setProtectedHeader({ alg: 'EdDSA', kid: keyId })
    .setSubject(userId)
    .setIssuer(issuer)
    .setAudience(options.aud ?? audience)
    .setIssuedAt(issuedAt)
    .setExpirationTime(options.expired ? now - 300 : issuedAt + 300)
    .sign(privateKey);
}

async function call(
  path: string,
  userId: string,
  init: RequestInit = {},
  tokenOptions: Parameters<typeof tokenFor>[1] = {},
  requestEnv: Env = testEnv
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${await tokenFor(userId, tokenOptions)}`);
  if (init.body !== undefined) headers.set('content-type', 'application/json');
  return worker.fetch(
    new Request(`https://keiko.example.test${path}`, {
      ...init,
      headers,
      body: init.body,
    }),
    requestEnv
  );
}

beforeAll(async () => {
  originalFetch = globalThis.fetch;
  const keys = await generateKeyPair('EdDSA', { crv: 'Ed25519' });
  privateKey = keys.privateKey;
  publicJwk = {
    ...(await exportJWK(keys.publicKey)),
    alg: 'EdDSA',
    kid: keyId,
    use: 'sig',
  };
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.href === jwksUrl) return Response.json({ keys: [publicJwk] });
    if (url.href === `${issuer}/jwks-failure`) {
      return new Response('not found', { status: 404 });
    }
    if (url.href === `${issuer}/jwks-network-failure`) {
      throw new TypeError('fetch failed');
    }
    throw new Error(`Unexpected fetch: ${url.href}`);
  });
});

afterAll(() => {
  vi.stubGlobal('fetch', originalFetch);
});

describe('Keiko session API', () => {
  it('queues only selected-repository GitHub operations and scopes job access to its owner', async () => {
    const userId = `github-operation-${crypto.randomUUID()}`;
    await env.DB.prepare(
      `INSERT INTO github_installations
       (user_id, installation_id, repository_owner, repository_name, repository_id, granted_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(userId, 731, 'CyanAutomation', 'matmetrics', 88, new Date().toISOString()).run();

    const arbitraryRepository = await call('/v1/github/health', userId, {
      method: 'POST', body: JSON.stringify({ owner: 'attacker', repo: 'elsewhere' }),
    }, { scope: 'github:read' });
    expect(arbitraryRepository.status).toBe(400);

    const queued = await call('/v1/github/health', userId, {
      method: 'POST', body: '{}',
    }, { scope: 'github:read' });
    expect(queued.status).toBe(202);
    const job = await queued.json() as { id: string; type: string; status: string };
    expect(job).toMatchObject({ type: 'github-health', status: 'queued' });

    const anotherUser = await call(`/v1/github/jobs/${job.id}`, `${userId}-other`, {}, { scope: 'github:read' });
    expect(anotherUser.status).toBe(404);
    const owner = await call(`/v1/github/jobs/${job.id}`, userId, {}, { scope: 'github:read' });
    expect(owner.status).toBe(200);
    expect(await owner.json()).toMatchObject({ id: job.id, type: 'github-health', status: 'queued' });
    await env.DB.prepare('DELETE FROM github_installations WHERE user_id = ?').bind(userId).run();
  });

  it('links a GitHub sync job to its D1 snapshot backup job', async () => {
    const userId = `github-sync-${crypto.randomUUID()}`;
    await env.DB.prepare(
      `INSERT INTO github_installations
       (user_id, installation_id, repository_owner, repository_name, repository_id, granted_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(userId, 732, 'CyanAutomation', 'matmetrics', 88, new Date().toISOString()).run();
    const send = vi.fn(async (_message: unknown) => {});
    const operationEnv = Object.assign(Object.create(testEnv), {
      BACKUP_QUEUE: { send },
    }) as Env;

    try {
      const response = await call('/v1/github/sync-all', userId, {
        method: 'POST', body: '{}',
      }, { scope: 'github:write' }, operationEnv);

      expect(response.status).toBe(202);
      const job = await response.json() as { id: string; type: string; status: string };
      expect(job).toMatchObject({ type: 'github-sync-all', status: 'queued' });
      expect(send).toHaveBeenCalledWith({ jobId: job.id, userId, operationId: job.id });
      expect(await env.DB.prepare('SELECT status FROM backup_jobs WHERE id = ?').bind(job.id).first())
        .toMatchObject({ status: 'queued' });
      expect(await env.DB.prepare('SELECT type, status FROM github_operation_jobs WHERE id = ?').bind(job.id).first())
        .toMatchObject({ type: 'github-sync-all', status: 'queued' });
    } finally {
      await env.DB.prepare('DELETE FROM backup_jobs WHERE user_id = ?').bind(userId).run();
      await env.DB.prepare('DELETE FROM github_operation_jobs WHERE user_id = ?').bind(userId).run();
      await env.DB.prepare('DELETE FROM github_installations WHERE user_id = ?').bind(userId).run();
    }
  });

  it('rejects unsafe Log Doctor paths and requires explicit apply confirmation', async () => {
    const userId = `github-fix-validation-${crypto.randomUUID()}`;
    const unsafePath = await call('/v1/github/log-doctor/fix', userId, {
      method: 'POST', body: JSON.stringify({ mode: 'dry-run', paths: ['data/2026/10/../../secrets.md'] }),
    }, { scope: 'github:write' });
    expect(unsafePath.status).toBe(400);

    const unconfirmedApply = await call('/v1/github/log-doctor/fix', userId, {
      method: 'POST', body: JSON.stringify({ mode: 'apply', paths: ['data/2026/10/20261024-matmetrics-session-1.md'] }),
    }, { scope: 'github:write' });
    expect(unconfirmedApply.status).toBe(400);
  });

  it('requires a Keiko-only audience, subject, expiry, and operation scope', async () => {
    const wrongAudience = await call('/v1/sessions', 'user-a', {}, {
      aud: 'matmetrics-api',
    });
    expect(wrongAudience.status).toBe(401);

    const missingScope = await call('/v1/sessions', 'user-a', {}, {
      scope: 'backups:read',
    });
    expect(missingScope.status).toBe(403);

    const expired = await call('/v1/sessions', 'user-a', {}, { expired: true });
    expect(expired.status).toBe(401);

    const smallClockSkew = await call('/v1/sessions?limit=1', 'user-a', {}, {
      scope: 'sessions:read',
      issuedAtOffsetSeconds: 4,
    });
    expect(smallClockSkew.status).toBe(200);

    const excessiveClockSkew = await call('/v1/sessions?limit=1', 'user-a', {}, {
      scope: 'sessions:read',
      issuedAtOffsetSeconds: 10,
    });
    expect(excessiveClockSkew.status).toBe(401);
  });

  it('applies configured rate limits after verification using the verified user key', async () => {
    const limit = vi.fn(async (_input: { key: string }) => ({ success: false }));
    const rateLimitedToken = await tokenFor('rate-limited-user', { scope: 'sessions:read' });
    const limitedEnv = {
      ENVIRONMENT: 'production',
      AUTH_JWKS_URL: jwksUrl,
      AUTH_ISSUER: issuer,
      AUTH_AUDIENCE: audience,
      SESSION_READ_LIMITER: { limit },
      SESSION_WRITE_LIMITER: allowRateLimit,
      BACKUP_WRITE_LIMITER: allowRateLimit,
    } as unknown as Env;
    await expect(authenticateRequest(
      new Request('https://keiko.example.test/v1/analytics/summary', {
        headers: { authorization: `Bearer ${rateLimitedToken}` },
      }),
      limitedEnv,
      'sessions:read'
    )).rejects.toMatchObject({ kind: 'rate_limited' });
    expect(limit).toHaveBeenCalledWith({ key: 'rate-limited-user' });
  });

  it('creates, lists, updates with a revision, and deletes a session', async () => {
    const created = await call('/v1/sessions', 'user-a', {
      method: 'POST',
      body: JSON.stringify(testSession),
    });
    expect(created.status).toBe(201);
    expect(created.headers.get('etag')).toBe('"1"');

    const listed = await call('/v1/sessions?limit=10', 'user-a');
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({
      data: [{ session: { id: testSession.id }, revision: 1 }],
      pagination: { hasMore: false, nextCursor: null },
    });

    const updated = await call(`/v1/sessions/${testSession.id}`, 'user-a', {
      method: 'PUT',
      headers: { 'if-match': '"1"' },
      body: JSON.stringify({ ...testSession, notes: 'Updated notes' }),
    });
    expect(updated.status).toBe(200);
    expect(updated.headers.get('etag')).toBe('"2"');

    const stale = await call(`/v1/sessions/${testSession.id}`, 'user-a', {
      method: 'PUT',
      headers: { 'if-match': '"1"' },
      body: JSON.stringify(testSession),
    });
    expect(stale.status).toBe(412);

    const deleted = await call(`/v1/sessions/${testSession.id}`, 'user-a', {
      method: 'DELETE',
      headers: { 'if-match': '"2"' },
    });
    expect(deleted.status).toBe(204);
  });

  it('keeps session records isolated by verified user', async () => {
    expect(
      (
        await call('/v1/sessions', 'user-a', {
          method: 'POST',
          body: JSON.stringify(testSession),
        })
      ).status
    ).toBe(201);

    const otherUsersList = await call('/v1/sessions', 'user-b');
    expect(await otherUsersList.json()).toMatchObject({
      data: [],
      pagination: { hasMore: false },
    });
    expect((await call(`/v1/sessions/${testSession.id}`, 'user-b')).status).toBe(
      404
    );
  });

  it('returns a user-scoped analytics summary', async () => {
    await call('/v1/sessions', 'user-a', {
      method: 'POST',
      body: JSON.stringify(testSession),
    });
    const response = await call('/v1/analytics/summary', 'user-a');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      totalSessions: 1,
      averageEffort: 4,
      distributions: {
        all: { categories: [{ name: 'Technical', count: 1 }] },
      },
    });
  });

  it('validates session data and paginates in a stable order', async () => {
    const invalid = await call('/v1/sessions', 'validation-user', {
      method: 'POST',
      body: JSON.stringify({ ...testSession, techniques: 'not-an-array' }),
    });
    expect(invalid.status).toBe(400);

    for (const id of ['page-a', 'page-b']) {
      expect((await call('/v1/sessions', 'pagination-user', {
        method: 'POST',
        body: JSON.stringify({ ...testSession, id }),
      })).status).toBe(201);
    }
    const first = await call('/v1/sessions?limit=1', 'pagination-user');
    const firstPage = await first.json() as {
      data: Array<{ session: { id: string } }>;
      pagination: { nextCursor: string; hasMore: boolean };
    };
    expect(firstPage.data).toHaveLength(1);
    expect(firstPage.pagination.hasMore).toBe(true);
    const second = await call(
      `/v1/sessions?limit=1&cursor=${encodeURIComponent(firstPage.pagination.nextCursor)}`,
      'pagination-user'
    );
    const secondPage = await second.json() as { data: Array<{ session: { id: string } }> };
    expect(secondPage.data).toHaveLength(1);
    expect(secondPage.data[0]?.session.id).not.toBe(firstPage.data[0]?.session.id);
  });

  it('isolates backup status and queues a backup only for the caller', async () => {
    const unauthorized = await call('/v1/backups/status', 'backup-user', {}, {
      scope: 'sessions:read',
    });
    expect(unauthorized.status).toBe(403);

    const requested = await call('/v1/backups', 'backup-user', {
      method: 'POST',
      body: JSON.stringify({}),
    }, { scope: 'backups:write' });
    expect(requested.status).toBe(202);
    const otherStatus = await call('/v1/backups/status', 'other-user', {}, {
      scope: 'backups:read',
    });
    expect(await otherStatus.json()).toMatchObject({
      latestJob: null,
      snapshots: [],
    });
  });

  it('rejects oversized backup and MCP bodies without relying on Content-Length', async () => {
    const backup = await call('/v1/backups', 'large-backup-body', {
      method: 'POST',
      body: ' '.repeat(64 * 1024 + 1),
    }, { scope: 'backups:write' });
    expect(backup.status).toBe(413);
    expect(await backup.json()).toMatchObject({ error: { code: 'payload_too_large' } });

    const mcp = await call('/mcp', 'large-mcp-body', {
      method: 'POST',
      body: ' '.repeat(1024 * 1024 + 1),
    }, { scope: 'sessions:read' });
    expect(mcp.status).toBe(413);
    expect(await mcp.json()).toMatchObject({ error: { code: 'payload_too_large' } });
  });

  it('previews restores, requires confirmation, and preserves newer D1 records', async () => {
    const userId = 'restore-user';
    const id = 'restore-session';
    const current = { ...testSession, id, notes: 'newer D1 content' };
    await call('/v1/sessions', userId, {
      method: 'POST',
      body: JSON.stringify(current),
    });
    await env.DB.prepare(
      `UPDATE sessions SET updated_at = ? WHERE user_id = ? AND id = ?`
    ).bind('2099-01-01T00:00:00.000Z', userId, id).run();
    const snapshotId = `snapshot-${crypto.randomUUID()}`;
    const jobId = `job-${crypto.randomUUID()}`;
    const snapshotSession = { ...current, notes: 'older backup content' };
    await env.DB.prepare(
      `INSERT INTO backup_jobs (id, user_id, status, requested_at, completed_at)
       VALUES (?, ?, 'completed', ?, ?)`
    ).bind(jobId, userId, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:01.000Z').run();
    const snapshotPayload = JSON.stringify([{
      id,
      session_date: snapshotSession.date,
      category: snapshotSession.category,
      effort: snapshotSession.effort,
      payload: JSON.stringify(snapshotSession),
      revision: 1,
      updated_at: '2026-01-01T00:00:00.000Z',
    }]);
    const snapshotDigest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(snapshotPayload)
    );
    const snapshotChecksum = Array.from(new Uint8Array(snapshotDigest), (value) =>
      value.toString(16).padStart(2, '0')
    ).join('');
    await env.DB.prepare(
      `INSERT INTO backup_snapshots
       (id, user_id, job_id, created_at, session_count, checksum, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      snapshotId,
      userId,
      jobId,
      '2026-01-01T00:00:01.000Z',
      1,
      snapshotChecksum,
      snapshotPayload
    ).run();

    const preview = await call(`/v1/backups/${snapshotId}/restore-preview`, userId, {}, {
      scope: 'backups:restore',
    });
    expect(await preview.json()).toMatchObject({ preservedNewerCount: 1 });
    const unconfirmed = await call(`/v1/backups/${snapshotId}/restore`, userId, {
      method: 'POST',
      body: JSON.stringify({ confirm: false }),
    }, { scope: 'backups:restore' });
    expect(unconfirmed.status).toBe(400);
    const restored = await call(`/v1/backups/${snapshotId}/restore`, userId, {
      method: 'POST',
      body: JSON.stringify({ confirm: true }),
    }, { scope: 'backups:restore' });
    expect(restored.status).toBe(200);
    const record = await call(`/v1/sessions/${id}`, userId);
    expect(await record.json()).toMatchObject({
      data: { session: { notes: 'newer D1 content' } },
    });
  });

  it('rejects corrupted or tampered snapshots before preview or restore', async () => {
    const userId = `invalid-snapshot-${crypto.randomUUID()}`;
    const snapshotId = `snapshot-${crypto.randomUUID()}`;
    const jobId = `job-${crypto.randomUUID()}`;
    const invalidPayload = JSON.stringify([{
      id: 'invalid-session',
      session_date: '2026-10-16',
      category: 'Technical',
      effort: 3,
      payload: JSON.stringify({
        id: 'invalid-session', date: '2026-10-16', effort: 3,
        category: 'Technical', techniques: 'not-an-array',
      }),
      revision: 1,
      updated_at: '2026-10-16T12:00:00.000Z',
    }]);
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(invalidPayload));
    const checksum = Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('');
    await env.DB.prepare(
      `INSERT INTO backup_jobs (id, user_id, status, requested_at, completed_at)
       VALUES (?, ?, 'completed', ?, ?)`
    ).bind(jobId, userId, '2026-10-16T12:00:00.000Z', '2026-10-16T12:00:01.000Z').run();
    await env.DB.prepare(
      `INSERT INTO backup_snapshots
       (id, user_id, job_id, created_at, session_count, checksum, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(snapshotId, userId, jobId, '2026-10-16T12:00:00.000Z', 1, checksum, invalidPayload).run();

    const preview = await call(`/v1/backups/${snapshotId}/restore-preview`, userId, {}, {
      scope: 'backups:restore',
    });
    expect(preview.status).toBe(500);
    const restore = await call(`/v1/backups/${snapshotId}/restore`, userId, {
      method: 'POST',
      body: JSON.stringify({ confirm: true }),
    }, { scope: 'backups:restore' });
    expect(restore.status).toBe(500);
    expect(await env.DB.prepare('SELECT id FROM sessions WHERE user_id = ?').bind(userId).all()).toMatchObject({
      results: [],
    });
  });

  it('rejects a snapshot with a checksum that does not match its payload', async () => {
    const userId = `checksum-snapshot-${crypto.randomUUID()}`;
    const snapshotId = `snapshot-${crypto.randomUUID()}`;
    const jobId = `job-${crypto.randomUUID()}`;
    const payload = '[]';
    await env.DB.prepare(
      `INSERT INTO backup_jobs (id, user_id, status, requested_at, completed_at)
       VALUES (?, ?, 'completed', ?, ?)`
    ).bind(jobId, userId, '2026-10-16T12:00:00.000Z', '2026-10-16T12:00:01.000Z').run();
    await env.DB.prepare(
      `INSERT INTO backup_snapshots
       (id, user_id, job_id, created_at, session_count, checksum, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(snapshotId, userId, jobId, '2026-10-16T12:00:00.000Z', 0, '0'.repeat(64), payload).run();

    const response = await call(`/v1/backups/${snapshotId}/restore-preview`, userId, {}, {
      scope: 'backups:restore',
    });
    expect(response.status).toBe(500);
  });

  it('rejects snapshots when a row identity disagrees with its nested session', async () => {
    const userId = `metadata-snapshot-${crypto.randomUUID()}`;
    const snapshotId = `snapshot-${crypto.randomUUID()}`;
    const jobId = `job-${crypto.randomUUID()}`;
    const session = { ...testSession, id: 'nested-session-id' };
    const payload = JSON.stringify([{
      id: 'row-session-id',
      session_date: session.date,
      category: session.category,
      effort: session.effort,
      payload: JSON.stringify(session),
      revision: 1,
      updated_at: '2026-10-16T12:00:00.000Z',
    }]);
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
    const checksum = Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('');
    await env.DB.prepare(
      `INSERT INTO backup_jobs (id, user_id, status, requested_at, completed_at)
       VALUES (?, ?, 'completed', ?, ?)`
    ).bind(jobId, userId, '2026-10-16T12:00:00.000Z', '2026-10-16T12:00:01.000Z').run();
    await env.DB.prepare(
      `INSERT INTO backup_snapshots
       (id, user_id, job_id, created_at, session_count, checksum, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(snapshotId, userId, jobId, '2026-10-16T12:00:00.000Z', 1, checksum, payload).run();

    const response = await call(`/v1/backups/${snapshotId}/restore-preview`, userId, {}, {
      scope: 'backups:restore',
    });
    expect(response.status).toBe(500);
  });

  it('validates a saved snapshot before retrying its GitHub backup job', async () => {
    const userId = `retry-snapshot-${crypto.randomUUID()}`;
    const jobId = `job-${crypto.randomUUID()}`;
    const snapshotId = `snapshot-${crypto.randomUUID()}`;
    const payload = '[]';
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
    const checksum = Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('');
    await env.DB.prepare(
      `INSERT INTO backup_jobs (id, user_id, status, requested_at)
       VALUES (?, ?, 'queued', ?)`
    ).bind(jobId, userId, '2026-10-16T12:00:00.000Z').run();
    await env.DB.prepare(
      `INSERT INTO backup_snapshots
       (id, user_id, job_id, created_at, session_count, checksum, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(snapshotId, userId, jobId, '2026-10-16T12:00:00.000Z', 1, checksum, payload).run();

    const retry = vi.fn();
    const ack = vi.fn();
    await processBackupMessage({
      body: { jobId, userId },
      attempts: 1,
      retry,
      ack,
    } as unknown as Message<{ jobId: string; userId: string }>, testEnv);

    expect(retry).toHaveBeenCalledOnce();
    expect(ack).not.toHaveBeenCalled();
    expect(await env.DB.prepare('SELECT status FROM backup_jobs WHERE id = ?').bind(jobId).first()).toMatchObject({
      status: 'queued',
    });
  });

  it('marks a terminal backup retry failed before Cloudflare transfers it to the DLQ', async () => {
    const userId = `terminal-retry-${crypto.randomUUID()}`;
    const jobId = `job-${crypto.randomUUID()}`;
    const snapshotId = `snapshot-${crypto.randomUUID()}`;
    const payload = '[]';
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
    const checksum = Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('');
    await env.DB.prepare(
      `INSERT INTO backup_jobs (id, user_id, status, requested_at)
       VALUES (?, ?, 'queued', ?)`
    ).bind(jobId, userId, '2026-10-16T12:00:00.000Z').run();
    await env.DB.prepare(
      `INSERT INTO backup_snapshots
       (id, user_id, job_id, created_at, session_count, checksum, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(snapshotId, userId, jobId, '2026-10-16T12:00:00.000Z', 1, checksum, payload).run();

    const retry = vi.fn();
    const ack = vi.fn();
    await processBackupMessage({
      body: { jobId, userId },
      attempts: 5,
      retry,
      ack,
    } as unknown as Message<{ jobId: string; userId: string }>, testEnv);

    expect(retry).toHaveBeenCalledWith({ delaySeconds: 160 });
    expect(ack).not.toHaveBeenCalled();
    expect(await env.DB.prepare(
      'SELECT status, error_code FROM backup_jobs WHERE id = ?'
    ).bind(jobId).first()).toMatchObject({ status: 'failed', error_code: 'backup_failed' });
  });

  it('keeps retrying a failed job on its final delivery so Cloudflare can transfer it to the DLQ', async () => {
    const userId = `terminal-redelivery-${crypto.randomUUID()}`;
    const jobId = `job-${crypto.randomUUID()}`;
    const snapshotId = `snapshot-${crypto.randomUUID()}`;
    const payload = '[]';
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
    const checksum = Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('');
    await env.DB.prepare(
      `INSERT INTO backup_jobs (id, user_id, status, requested_at, error_code)
       VALUES (?, ?, 'failed', ?, 'backup_failed')`
    ).bind(jobId, userId, '2026-10-16T12:00:00.000Z').run();
    await env.DB.prepare(
      `INSERT INTO backup_snapshots
       (id, user_id, job_id, created_at, session_count, checksum, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(snapshotId, userId, jobId, '2026-10-16T12:00:00.000Z', 1, checksum, payload).run();

    const retry = vi.fn();
    const ack = vi.fn();
    await processBackupMessage({
      body: { jobId, userId },
      attempts: 6,
      retry,
      ack,
    } as unknown as Message<{ jobId: string; userId: string }>, testEnv);

    expect(retry).toHaveBeenCalledOnce();
    expect(ack).not.toHaveBeenCalled();
    expect(await env.DB.prepare(
      'SELECT status, error_code FROM backup_jobs WHERE id = ?'
    ).bind(jobId).first()).toMatchObject({ status: 'failed', error_code: 'backup_failed' });
  });

  it('creates and completes a valid snapshot for a queued backup', async () => {
    const userId = `valid-backup-${crypto.randomUUID()}`;
    const jobId = `job-${crypto.randomUUID()}`;
    await env.DB.prepare(
      `INSERT INTO backup_jobs (id, user_id, status, requested_at)
       VALUES (?, ?, 'queued', ?)`
    ).bind(jobId, userId, new Date().toISOString()).run();
    const ack = vi.fn();
    const retry = vi.fn();
    await processBackupMessage({
      body: { jobId, userId },
      attempts: 1,
      retry,
      ack,
    } as unknown as Message<{ jobId: string; userId: string }>, testEnv);

    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
    expect(await env.DB.prepare('SELECT status FROM backup_jobs WHERE id = ?').bind(jobId).first()).toMatchObject({
      status: 'completed',
    });
    expect(await env.DB.prepare('SELECT session_count FROM backup_snapshots WHERE job_id = ?').bind(jobId).first()).toMatchObject({
      session_count: 0,
    });
  });

  it('keeps one snapshot when duplicate queue deliveries process the same job concurrently', async () => {
    const userId = `concurrent-backup-${crypto.randomUUID()}`;
    const jobId = `job-${crypto.randomUUID()}`;
    await env.DB.prepare(
      `INSERT INTO backup_jobs (id, user_id, status, requested_at)
       VALUES (?, ?, 'queued', ?)`
    ).bind(jobId, userId, new Date().toISOString()).run();
    const acks = [vi.fn(), vi.fn()];
    const retries = [vi.fn(), vi.fn()];
    const messages = [0, 1].map((index) => ({
      body: { jobId, userId },
      attempts: 1,
      retry: retries[index],
      ack: acks[index],
    } as unknown as Message<{ jobId: string; userId: string }>));

    await Promise.all(messages.map((message) => processBackupMessage(message, testEnv)));

    const snapshots = await env.DB.prepare(
      'SELECT id FROM backup_snapshots WHERE job_id = ?'
    ).bind(jobId).all();
    expect(snapshots.results).toHaveLength(1);
    expect(await env.DB.prepare('SELECT status FROM backup_jobs WHERE id = ?').bind(jobId).first()).toMatchObject({
      status: 'completed',
    });
    expect(acks.every((ack) => ack.mock.calls.length === 1)).toBe(true);
    expect(retries.every((retry) => retry.mock.calls.length === 0)).toBe(true);
  });

  it('deduplicates scheduled backup jobs for the same schedule occurrence', async () => {
    const userId = `scheduled-backup-${crypto.randomUUID()}`;
    await env.DB.prepare(
      `INSERT INTO github_installations
       (user_id, installation_id, repository_owner, repository_name, repository_id, granted_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL)`
    ).bind(userId, 99001, 'owner', 'repo', 99001, new Date().toISOString()).run();
    const send = vi.fn(async (_message: unknown) => {});
    const scheduledEnv = Object.assign(Object.create(env), {
      SCHEDULED_BACKUPS_ENABLED: 'true',
      BACKUP_QUEUE: { send },
    }) as Env;
    const scheduledTime = Date.parse('2026-10-17T03:00:00.000Z');
    const controller = { cron: '0 3 * * *', scheduledTime } as ScheduledController;
    await worker.scheduled!(controller, scheduledEnv);
    await worker.scheduled!(controller, scheduledEnv);

    expect(send).toHaveBeenCalledTimes(1);
    const jobs = await env.DB.prepare(
      'SELECT id FROM backup_jobs WHERE user_id = ? AND requested_at = ?'
    ).bind(userId, new Date(scheduledTime).toISOString()).all();
    expect(jobs.results).toHaveLength(1);
  });

  it('does not dispatch scheduled backups when the environment kill switch is disabled', async () => {
    const userId = `scheduled-disabled-${crypto.randomUUID()}`;
    await env.DB.prepare(
      `INSERT INTO github_installations
       (user_id, installation_id, repository_owner, repository_name, repository_id, granted_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL)`
    ).bind(userId, 99004, 'owner', 'repo', 99004, new Date().toISOString()).run();
    const send = vi.fn(async (_message: unknown) => {});
    const scheduledEnv = Object.assign(Object.create(env), {
      SCHEDULED_BACKUPS_ENABLED: 'false',
      BACKUP_QUEUE: { send },
    }) as Env;

    await worker.scheduled!(
      { cron: '0 3 * * *', scheduledTime: Date.now() } as ScheduledController,
      scheduledEnv
    );

    expect(send).not.toHaveBeenCalled();
    expect(await env.DB.prepare(
      'SELECT id FROM backup_jobs WHERE user_id = ?'
    ).bind(userId).all()).toMatchObject({ results: [] });
  });

  it('retries scheduled queue dispatch after a failed send without creating a second job', async () => {
    const userId = `scheduled-retry-${crypto.randomUUID()}`;
    await env.DB.prepare('DELETE FROM github_installations').run();
    await env.DB.prepare(
      `INSERT INTO github_installations
       (user_id, installation_id, repository_owner, repository_name, repository_id, granted_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL)`
    ).bind(userId, 99002, 'owner', 'repo', 99002, new Date().toISOString()).run();
    const send = vi.fn()
      .mockRejectedValueOnce(new Error('queue unavailable'))
      .mockResolvedValueOnce(undefined);
    const scheduledEnv = Object.assign(Object.create(env), {
      SCHEDULED_BACKUPS_ENABLED: 'true',
      BACKUP_QUEUE: { send },
    }) as Env;
    const scheduledTime = Date.parse('2026-10-17T04:00:00.000Z');
    const controller = { cron: '0 4 * * *', scheduledTime } as ScheduledController;
    await worker.scheduled!(controller, scheduledEnv);
    await worker.scheduled!(controller, scheduledEnv);

    expect(send).toHaveBeenCalledTimes(2);
    const jobs = await env.DB.prepare(
      `SELECT id, status FROM backup_jobs
       WHERE user_id = ? AND requested_at = ?`
    ).bind(userId, new Date(scheduledTime).toISOString()).all();
    expect(jobs.results).toHaveLength(1);
    expect(jobs.results[0]).toMatchObject({ status: 'queued' });
    expect(send.mock.calls[0]?.[0]).toMatchObject({ jobId: jobs.results[0]?.id });
    expect(send.mock.calls[1]?.[0]).toMatchObject({ jobId: jobs.results[0]?.id });
  });

  it('recovers a stale scheduled job from an earlier occurrence', async () => {
    const userId = `scheduled-stale-${crypto.randomUUID()}`;
    await env.DB.prepare('DELETE FROM github_installations').run();
    await env.DB.prepare(
      `INSERT INTO github_installations
       (user_id, installation_id, repository_owner, repository_name, repository_id, granted_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL)`
    ).bind(userId, 99003, 'owner', 'repo', 99003, new Date().toISOString()).run();
    const oldJobId = `job-${crypto.randomUUID()}`;
    const staleDispatchAt = new Date(Date.now() - 10 * 60_000).toISOString();
    await env.DB.prepare(
      `INSERT INTO backup_jobs
       (id, user_id, status, requested_at, schedule_key, dispatch_attempted_at)
       VALUES (?, ?, 'queued', ?, ?, ?)`
    ).bind(
      oldJobId,
      userId,
      new Date(Date.now() - 24 * 60 * 60_000).toISOString(),
      '0 3 * * *:previous-occurrence',
      staleDispatchAt
    ).run();
    const send = vi.fn(async (_message: unknown) => {});
    const scheduledEnv = Object.assign(Object.create(env), {
      SCHEDULED_BACKUPS_ENABLED: 'true',
      BACKUP_QUEUE: { send },
    }) as Env;

    await worker.scheduled!(
      { cron: '0 3 * * *', scheduledTime: Date.now() } as ScheduledController,
      scheduledEnv
    );

    expect(send).toHaveBeenCalledWith({ jobId: oldJobId, userId });
    expect(await env.DB.prepare('SELECT dispatch_attempted_at FROM backup_jobs WHERE id = ?').bind(oldJobId).first()).not.toMatchObject({
      dispatch_attempted_at: staleDispatchAt,
    });
  });

  it('exposes read-only MCP tools backed by the same user-scoped session service', async () => {
    await call('/v1/sessions', 'mcp-user', {
      method: 'POST',
      body: JSON.stringify(testSession),
    });
    const response = await call('/mcp', 'mcp-user', {
      method: 'POST',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'list_sessions', arguments: { limit: 10 } },
      }),
    }, { scope: 'sessions:read' });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      result: {
        structuredContent: {
          data: [{ session: { id: testSession.id } }],
        },
      },
    });
    const unauthorized = await call('/mcp', 'mcp-user', {
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    }, { scope: 'sessions:write' });
    expect(unauthorized.status).toBe(403);
  });

  it('keeps request logs free of session content and bearer tokens', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const secretText = 'private-training-note-do-not-log';
    try {
      await call('/v1/sessions', 'logging-user', {
        method: 'POST',
        body: JSON.stringify({ ...testSession, id: 'safe-log-test', notes: secretText }),
      });
      const serialized = log.mock.calls.map((args) => JSON.stringify(args)).join('\n');
      expect(serialized).not.toContain(secretText);
      expect(serialized).not.toContain('eyJ');
    } finally {
      log.mockRestore();
    }
  });

  it('reports readiness only when D1 and auth configuration are present', async () => {
    const response = await worker.fetch(
      new Request('https://keiko.example.test/readyz'),
      env
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ready' });
  });

  it('reports a non-200 JWKS response as authentication unavailable', async () => {
    const unavailableEnv = Object.assign(Object.create(testEnv), {
      AUTH_JWKS_URL: `${issuer}/jwks-failure`,
    }) as Env;
    const response = await call(
      '/v1/sessions?limit=1',
      'user-a',
      {},
      { scope: 'sessions:read' },
      unavailableEnv
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: {
        code: 'authentication_unavailable',
        message: 'Authentication service unavailable',
      },
    });
  });

  it('reports JWKS transport failures as authentication unavailable', async () => {
    const unavailableEnv = Object.assign(Object.create(testEnv), {
      AUTH_JWKS_URL: `${issuer}/jwks-network-failure`,
    }) as Env;
    const response = await call(
      '/v1/sessions?limit=1',
      'user-a',
      {},
      { scope: 'sessions:read' },
      unavailableEnv
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: {
        code: 'authentication_unavailable',
        message: 'Authentication service unavailable',
      },
    });
  });

  it.each([
    ['malformed compact token', 'not-a-jwt'],
    ['unsupported algorithm', 'eyJhbGciOiJIUzI1NiJ9.e30.AA'],
  ])('reports %s as an invalid access token', async (_description, token) => {
    const response = await worker.fetch(
      new Request('https://keiko.example.test/v1/sessions?limit=1', {
        headers: { authorization: `Bearer ${token}` },
      }),
      testEnv
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: {
        code: 'authentication_required',
        message: 'Invalid access token',
      },
    });
  });
});
