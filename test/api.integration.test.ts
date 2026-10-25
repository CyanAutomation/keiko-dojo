import { env } from 'cloudflare:workers';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { authenticateRequest } from '../src/auth/bearer-auth';
import worker from '../src/index';
import { processGitHubSessionSyncMessage } from '../src/http/github-sync';

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
  it('returns the GitHub installation callback to the MatMetrics dashboard', async () => {
    const callbackEnv = Object.assign(Object.create(testEnv), {
      ENVIRONMENT: 'production',
      MATMETRICS_FRONTEND_URL: 'https://matmetrics.example.test',
    }) as Env;
    const response = await worker.fetch(
      new Request('https://keiko.example.test/v1/backups/github-installation/callback?state=invalid'),
      callbackEnv
    );

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('location')!);
    expect(location.origin).toBe(callbackEnv.MATMETRICS_FRONTEND_URL);
    expect(location.pathname).toBe('/');
    expect(location.searchParams.get('githubBackup')).toBe('failed');
  });

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
      const response = await call('/v1/github/sync-all', userId, {
        method: 'POST', body: '{}',
      }, { scope: 'github:write' }, operationEnv);

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

  it('isolates GitHub Markdown sync status by the authenticated user', async () => {
    const unauthorized = await call('/v1/backups/status', 'backup-user', {}, {
      scope: 'sessions:read',
    });
    expect(unauthorized.status).toBe(403);

    const otherStatus = await call('/v1/backups/status', 'other-user', {}, {
      scope: 'backups:read',
    });
    expect(await otherStatus.json()).toMatchObject({
      configured: false,
      pending: false,
      lastSyncedAt: null,
    });
  });

  it('removes D1 restore endpoints and stored snapshot tables', async () => {
    const restore = await call('/v1/backups/snapshot-id/restore', 'restore-user', {
      method: 'POST', body: JSON.stringify({ confirm: true }),
    }, { scope: 'backups:write' });
    expect(restore.status).toBe(405);
    const tables = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('backup_snapshots', 'restore_activity', 'backup_jobs')"
    ).all<{ name: string }>();
    expect(tables.results).toEqual([]);
  });

  it('coalesces successful session mutations and queues one delayed GitHub sync', async () => {
    const userId = `session-sync-${crypto.randomUUID()}`;
    await env.DB.prepare(
      `INSERT INTO github_installations
       (user_id, installation_id, repository_owner, repository_name, repository_id, granted_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(userId, 900, 'CyanAutomation', 'matmetrics', 91, new Date().toISOString()).run();
    const send = vi.fn(async (_message: unknown, _options?: unknown) => {});
    const requestEnv = Object.assign(Object.create(testEnv), {
      BACKUP_QUEUE: { send },
    }) as Env;
    const session = { ...testSession, id: 'coalesced-session' };

    try {
      const created = await call('/v1/sessions', userId, {
        method: 'POST', body: JSON.stringify(session),
      }, {}, requestEnv);
      expect(created.status).toBe(201);
      const updated = await call(`/v1/sessions/${session.id}`, userId, {
        method: 'PUT', headers: { 'if-match': '\"1\"' },
        body: JSON.stringify({ ...session, notes: 'Quick correction' }),
      }, {}, requestEnv);
      expect(updated.status).toBe(200);
      const stale = await call(`/v1/sessions/${session.id}`, userId, {
        method: 'PUT', headers: { 'if-match': '"1"' },
        body: JSON.stringify(session),
      }, {}, requestEnv);
      expect(stale.status).toBe(412);
      const deleted = await call(`/v1/sessions/${session.id}`, userId, {
        method: 'DELETE', headers: { 'if-match': '\"2\"' },
      }, {}, requestEnv);
      expect(deleted.status).toBe(204);

      expect(send).toHaveBeenCalledOnce();
      expect(send).toHaveBeenCalledWith(
        { kind: 'github-session-sync', userId },
        { delaySeconds: 60 }
      );
      expect(await env.DB.prepare(
        'SELECT generation FROM github_session_sync_items WHERE user_id = ? AND session_id = ?'
      ).bind(userId, session.id).first()).toMatchObject({ generation: 3 });
      expect(await env.DB.prepare(
        'SELECT generation, wake_enqueued FROM github_session_sync_state WHERE user_id = ?'
      ).bind(userId).first()).toMatchObject({ generation: 3, wake_enqueued: 1 });
    } finally {
      await env.DB.prepare('DELETE FROM github_session_sync_state WHERE user_id = ?').bind(userId).run();
      await env.DB.prepare('DELETE FROM github_installations WHERE user_id = ?').bind(userId).run();
    }
  });

  it('keeps a successful D1 write successful when queue dispatch fails and retries it from cron', async () => {
    const userId = `session-sync-queue-failure-${crypto.randomUUID()}`;
    await env.DB.prepare(
      `INSERT INTO github_installations
       (user_id, installation_id, repository_owner, repository_name, repository_id, granted_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(userId, 903, 'CyanAutomation', 'matmetrics', 93, new Date().toISOString()).run();
    const failingSend = vi.fn(async () => { throw new Error('queue unavailable'); });
    const failingEnv = Object.assign(Object.create(testEnv), {
      BACKUP_QUEUE: { send: failingSend },
    }) as Env;
    const session = { ...testSession, id: 'queue-failure-session' };

    try {
      const response = await call('/v1/sessions', userId, {
        method: 'POST', body: JSON.stringify(session),
      }, {}, failingEnv);
      expect(response.status).toBe(201);
      expect(await env.DB.prepare(
        'SELECT id FROM sessions WHERE user_id = ? AND id = ?'
      ).bind(userId, session.id).first()).toMatchObject({ id: session.id });
      expect(await env.DB.prepare(
        'SELECT wake_enqueued, last_error FROM github_session_sync_state WHERE user_id = ?'
      ).bind(userId).first()).toMatchObject({ wake_enqueued: 0, last_error: 'queue_unavailable' });

      await env.DB.prepare(
        'UPDATE github_session_sync_state SET dispatch_after = ? WHERE user_id = ?'
      ).bind(new Date(0).toISOString(), userId).run();
      const send = vi.fn(async (_message: unknown, _options?: unknown) => {});
      const scheduleEnv = Object.assign(Object.create(testEnv), { BACKUP_QUEUE: { send } }) as Env;
      await worker.scheduled!({
        scheduledTime: Date.now(), cron: '* * * * *', noRetry: () => {},
      }, scheduleEnv);
      expect(send).toHaveBeenCalledWith(
        { kind: 'github-session-sync', userId },
        { delaySeconds: expect.any(Number) }
      );
      expect(await env.DB.prepare(
        'SELECT wake_enqueued FROM github_session_sync_state WHERE user_id = ?'
      ).bind(userId).first()).toMatchObject({ wake_enqueued: 1 });
    } finally {
      await env.DB.prepare('DELETE FROM github_session_sync_state WHERE user_id = ?').bind(userId).run();
      await env.DB.prepare('DELETE FROM github_installations WHERE user_id = ?').bind(userId).run();
      await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId).run();
    }
  });

  it('recovers sync work when a queue wake is stuck without an active lease', async () => {
    const userId = `session-sync-stale-wake-${crypto.randomUUID()}`;
    const staleTime = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    await env.DB.prepare(
      `INSERT INTO github_installations
       (user_id, installation_id, repository_owner, repository_name, repository_id, granted_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(userId, 905, 'CyanAutomation', 'matmetrics', 95, new Date().toISOString()).run();
    await env.DB.prepare(
      `INSERT INTO github_session_sync_state
       (user_id, repository_id, generation, full_sync_required, next_sync_at,
        wake_enqueued, wake_enqueued_at)
       VALUES (?, ?, 1, 1, ?, 1, ?)`
    ).bind(userId, 95, staleTime, staleTime).run();
    const send = vi.fn(async (_message: unknown, _options?: { delaySeconds: number }) => {});
    const scheduleEnv = Object.assign(Object.create(testEnv), {
      BACKUP_QUEUE: { send },
    }) as Env;

    try {
      await worker.scheduled!({
        scheduledTime: Date.now(), cron: '* * * * *', noRetry: () => {},
      }, scheduleEnv);
      expect(send).toHaveBeenCalledWith(
        { kind: 'github-session-sync', userId },
        { delaySeconds: 0 }
      );
      expect(await env.DB.prepare(
        'SELECT wake_enqueued, wake_enqueued_at FROM github_session_sync_state WHERE user_id = ?'
      ).bind(userId).first()).toMatchObject({ wake_enqueued: 1 });
    } finally {
      await env.DB.prepare('DELETE FROM github_session_sync_state WHERE user_id = ?').bind(userId).run();
      await env.DB.prepare('DELETE FROM github_installations WHERE user_id = ?').bind(userId).run();
    }
  });

  it('waits for the latest edit in the debounce window before calling GitHub', async () => {
    const userId = `session-sync-delay-${crypto.randomUUID()}`;
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO github_installations
       (user_id, installation_id, repository_owner, repository_name, repository_id, granted_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(userId, 901, 'CyanAutomation', 'matmetrics', 92, new Date().toISOString()).run();
    await env.DB.prepare(
      `INSERT INTO github_session_sync_state
       (user_id, repository_id, generation, full_sync_required, next_sync_at, wake_enqueued)
       VALUES (?, ?, 1, 0, ?, 1)`
    ).bind(userId, 92, new Date(now + 25_000).toISOString()).run();
    const ack = vi.fn();
    const retry = vi.fn();
      const send = vi.fn(async (_message: unknown, _options?: { delaySeconds: number }) => {});
    const syncEnv = Object.assign(Object.create(testEnv), {
      BACKUP_QUEUE: { send },
    }) as Env;
    const priorFetch = globalThis.fetch;
    vi.stubGlobal('fetch', async () => { throw new Error('GitHub should not be contacted before the debounce expires'); });

    try {
      await processGitHubSessionSyncMessage({
        body: { kind: 'github-session-sync', userId }, attempts: 1, ack, retry,
      } as unknown as Message<{ kind: 'github-session-sync'; userId: string }>, syncEnv);
      expect(ack).toHaveBeenCalledOnce();
      expect(retry).not.toHaveBeenCalled();
      expect(send).toHaveBeenCalledWith(
        { kind: 'github-session-sync', userId },
        { delaySeconds: expect.any(Number) }
      );
      expect(send.mock.calls[0]?.[1]?.delaySeconds).toBeGreaterThan(0);
    } finally {
      vi.stubGlobal('fetch', priorFetch);
      await env.DB.prepare('DELETE FROM github_session_sync_state WHERE user_id = ?').bind(userId).run();
      await env.DB.prepare('DELETE FROM github_installations WHERE user_id = ?').bind(userId).run();
    }
  });

  it('rejects oversized GitHub sync and MCP bodies without relying on Content-Length', async () => {
    const sync = await call('/v1/github/sync-all', 'large-sync-body', {
      method: 'POST', body: ' '.repeat(64 * 1024 + 1),
    }, { scope: 'github:write' });
    expect(sync.status).toBe(413);
    expect(await sync.json()).toMatchObject({ error: { code: 'payload_too_large' } });

    const mcp = await call('/mcp', 'large-mcp-body', {
      method: 'POST',
      body: ' '.repeat(1024 * 1024 + 1),
    }, { scope: 'sessions:read' });
    expect(mcp.status).toBe(413);
    expect(await mcp.json()).toMatchObject({ error: { code: 'payload_too_large' } });
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
