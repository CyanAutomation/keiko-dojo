import { env } from 'cloudflare:workers';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { authenticateRequest } from '../src/auth/bearer-auth';
import worker from '../src/index';

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
  options: { aud?: string; scope?: string; expired?: boolean } = {}
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    appUserId: userId,
    scope: options.scope ?? 'sessions:read sessions:write',
  })
    .setProtectedHeader({ alg: 'EdDSA', kid: keyId })
    .setSubject(userId)
    .setIssuer(issuer)
    .setAudience(options.aud ?? audience)
    .setIssuedAt(options.expired ? now - 600 : now)
    .setExpirationTime(options.expired ? now - 300 : now + 300)
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
    if (url.href !== jwksUrl) throw new Error(`Unexpected fetch: ${url.href}`);
    return Response.json({ keys: [publicJwk] });
  });
});

afterAll(() => {
  vi.stubGlobal('fetch', originalFetch);
});

describe('Keiko session API', () => {
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
      'test-checksum',
      JSON.stringify([{
        id,
        session_date: snapshotSession.date,
        category: snapshotSession.category,
        effort: snapshotSession.effort,
        payload: JSON.stringify(snapshotSession),
        revision: 1,
        updated_at: '2026-01-01T00:00:00.000Z',
      }])
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
});
