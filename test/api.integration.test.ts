import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import { authenticateRequest } from '../src/auth/bearer-auth';
import worker from '../src/index';
import { processGitHubSessionSyncMessage } from '../src/http/github-sync';
import { credentialBearingVideoUrl } from './helpers';
import { createApiHarness } from './api-harness';

const { issuer, jwksUrl, audience, testEnv, tokenFor, call } = createApiHarness();
const allowRateLimit = { limit: async (_input: { key: string }) => ({ success: true }) };
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

describe('Keiko session API', () => {
  it('requires a Keiko-only audience, subject, expiry, and operation scope', async () => {
    const wrongAudience = await call('/v1/sessions', 'user-a', {}, {
      aud: 'matmetrics-api',
    });
    expect(wrongAudience.status).toBe(401);

    const mismatchedSubject = await call('/v1/sessions?limit=1', 'user-a', {}, {
      subject: 'another-user',
      scope: 'sessions:read',
    });
    expect(mismatchedSubject.status).toBe(401);

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
    const createdEtag = created.headers.get('etag');
    expect(createdEtag).toMatch(/^"1-[a-f0-9]{24}"$/);

    const listed = await call('/v1/sessions?limit=10', 'user-a');
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({
      data: [{ session: { id: testSession.id }, revision: 1 }],
      pagination: { hasMore: false, nextCursor: null },
    });

    const updated = await call(`/v1/sessions/${testSession.id}`, 'user-a', {
      method: 'PUT',
      headers: { 'if-match': createdEtag! },
      body: JSON.stringify({ ...testSession, notes: 'Updated notes' }),
    });
    expect(updated.status).toBe(200);
    const updatedEtag = updated.headers.get('etag');
    expect(updatedEtag).toMatch(/^"2-[a-f0-9]{24}"$/);

    const stale = await call(`/v1/sessions/${testSession.id}`, 'user-a', {
      method: 'PUT',
      headers: { 'if-match': '"1"' },
      body: JSON.stringify(testSession),
    });
    expect(stale.status).toBe(412);

    const deleted = await call(`/v1/sessions/${testSession.id}`, 'user-a', {
      method: 'DELETE',
      headers: { 'if-match': updatedEtag! },
    });
    expect(deleted.status).toBe(204);
  });

  it('revalidates session reads with user-scoped ETags', async () => {
    const session = { ...testSession, id: `cache-${crypto.randomUUID()}` };
    const first = await call('/v1/sessions', 'cache-user-a', {
      method: 'POST', body: JSON.stringify(session),
    });
    const other = await call('/v1/sessions', 'cache-user-b', {
      method: 'POST', body: JSON.stringify(session),
    });
    const firstTag = first.headers.get('etag')!;
    const otherTag = other.headers.get('etag')!;
    expect(firstTag).not.toBe(otherTag);

    const notModified = await call(`/v1/sessions/${session.id}`, 'cache-user-a', {
      headers: { 'if-none-match': firstTag },
    });
    expect(notModified.status).toBe(304);
    expect(notModified.headers.get('cache-control')).toBe('private, no-cache');

    const otherUserRead = await call(`/v1/sessions/${session.id}`, 'cache-user-b', {
      headers: { 'if-none-match': firstTag },
    });
    expect(otherUserRead.status).toBe(200);
    expect(otherUserRead.headers.get('etag')).toBe(otherTag);
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

  it('returns an analytics summary scoped to the authenticated user', async () => {
    await call('/v1/sessions', 'user-a', {
      method: 'POST',
      body: JSON.stringify(testSession),
    });
    await call('/v1/sessions', 'other-analytics-user', {
      method: 'POST',
      body: JSON.stringify({ ...testSession, id: 'other-analytics-session', category: 'Randori', effort: 1 }),
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

  it('rejects video URLs that contain embedded credentials', async () => {
    const response = await call('/v1/sessions', 'video-url-credentials', {
      method: 'POST',
      body: JSON.stringify({
        ...testSession,
        id: 'credential-url',
        videoUrl: credentialBearingVideoUrl(),
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { message: 'Invalid videoUrl: credentials are not allowed' },
    });
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
        'UPDATE github_session_sync_state SET dispatch_after = ?, next_sync_at = ? WHERE user_id = ?'
      ).bind(new Date(0).toISOString(), new Date(0).toISOString(), userId).run();
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

  it('does not enqueue a scheduled wake before the debounce window expires', async () => {
    const userId = `session-sync-not-due-${crypto.randomUUID()}`;
    const nextSyncAt = new Date(Date.now() + 60_000).toISOString();
    await env.DB.prepare(
      `INSERT INTO github_installations
       (user_id, installation_id, repository_owner, repository_name, repository_id, granted_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(userId, 907, 'CyanAutomation', 'matmetrics', 97, new Date().toISOString()).run();
    await env.DB.prepare(
      `INSERT INTO github_session_sync_state
       (user_id, repository_id, generation, full_sync_required, next_sync_at)
       VALUES (?, ?, 1, 1, ?)`
    ).bind(userId, 97, nextSyncAt).run();
    const send = vi.fn(async (_message: unknown, _options?: { delaySeconds: number }) => {});
    const scheduleEnv = Object.assign(Object.create(testEnv), {
      BACKUP_QUEUE: { send },
    }) as Env;

    try {
      await worker.scheduled!({
        scheduledTime: Date.now(), cron: '* * * * *', noRetry: () => {},
      }, scheduleEnv);

      expect(send).not.toHaveBeenCalled();
      expect(await env.DB.prepare(
        'SELECT wake_enqueued FROM github_session_sync_state WHERE user_id = ?'
      ).bind(userId).first()).toMatchObject({ wake_enqueued: 0 });
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

  it('returns payload-too-large for oversized GitHub sync and MCP request bodies', async () => {
    const sync = await call('/v1/github/sync-all', 'large-sync-body', {
      method: 'POST', body: ' '.repeat(64 * 1024 + 1),
    }, { scope: 'github:write' });
    expect(sync.status).toBe(413);
    expect(await sync.json()).toMatchObject({ error: { code: 'payload_too_large' } });

    const mcp = await call('/mcp', 'large-mcp-body', {
      method: 'POST',
      body: ' '.repeat(64 * 1024 + 1),
    }, { scope: 'sessions:read' });
    expect(mcp.status).toBe(413);
    expect(await mcp.json()).toMatchObject({ error: { code: 'payload_too_large' } });
  });

  it('authenticates MCP requests before parsing their body', async () => {
    const response = await worker.fetch(
      new Request('https://keiko.example.test/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{invalid-json',
      }),
      testEnv
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: { code: 'authentication_required' },
    });
  });

  it('requires authentication for MCP initialization and negotiates for authorized clients', async () => {
    const initialize = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-11-25' },
    };
    const unauthorized = await worker.fetch(
      new Request('https://keiko.example.test/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(initialize),
      }),
      testEnv
    );
    expect(unauthorized.status).toBe(401);
    expect(await unauthorized.json()).toMatchObject({
      error: { code: 'authentication_required' },
    });

    const authorized = await call('/mcp', 'mcp-initialize', {
      method: 'POST',
      body: JSON.stringify(initialize),
    }, { scope: 'sessions:read' });
    expect(authorized.status).toBe(200);
    expect(await authorized.json()).toMatchObject({
      result: {
        protocolVersion: '2025-11-25',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'keiko-dojo', version: '1.0.0' },
      },
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
    const listedTools = await call('/mcp', 'mcp-user', {
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    }, { scope: 'sessions:read' });
    const toolList = await listedTools.json() as {
      result: { tools: Array<{ name: string; annotations: { readOnlyHint: boolean } }> };
    };
    expect(toolList.result.tools.map(({ name }) => name).sort()).toEqual([
      'get_session', 'get_training_summary', 'list_sessions',
    ]);
    expect(toolList.result.tools.every((tool) => tool.annotations.readOnlyHint)).toBe(true);

    const ownSession = await call('/mcp', 'mcp-user', {
      method: 'POST',
      body: JSON.stringify({
        jsonrpc: '2.0', id: 3, method: 'tools/call',
        params: { name: 'get_session', arguments: { id: testSession.id } },
      }),
    }, { scope: 'sessions:read' });
    expect(await ownSession.json()).toMatchObject({
      result: { structuredContent: { session: { id: testSession.id } } },
    });
    const otherUsersSession = await call('/mcp', 'other-mcp-user', {
      method: 'POST',
      body: JSON.stringify({
        jsonrpc: '2.0', id: 4, method: 'tools/call',
        params: { name: 'get_session', arguments: { id: testSession.id } },
      }),
    }, { scope: 'sessions:read' });
    expect(await otherUsersSession.json()).toMatchObject({
      result: { isError: true, structuredContent: { error: 'Session not found' } },
    });
    const unauthorized = await call('/mcp', 'mcp-user', {
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/list' }),
    }, { scope: 'sessions:write' });
    expect(unauthorized.status).toBe(403);
  });

  it('keeps request logs free of session content and bearer tokens', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const secretText = 'private-training-note-do-not-log';
    const bearerToken = await tokenFor('logging-user');
    try {
      await worker.fetch(new Request('https://keiko.example.test/v1/sessions', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${bearerToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ ...testSession, id: 'safe-log-test', notes: secretText }),
      }), testEnv);
      const serialized = log.mock.calls.map((args) => JSON.stringify(args)).join('\n');
      expect(serialized).not.toContain(secretText);
      expect(serialized).not.toContain(bearerToken);
      expect(serialized).not.toContain('authorization');
    } finally {
      log.mockRestore();
    }
  });

  it('reports ready when D1 and auth configuration are available', async () => {
    const response = await worker.fetch(
      new Request('https://keiko.example.test/readyz'),
      env
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ready' });
  });

  it.each(['AUTH_JWKS_URL', 'AUTH_ISSUER', 'AUTH_AUDIENCE'] as const)(
    'reports not ready when %s is missing',
    async (setting) => {
      const unavailableEnv = Object.create(env) as Env;
      Object.defineProperty(unavailableEnv, setting, { value: '' });
      const response = await worker.fetch(
        new Request('https://keiko.example.test/readyz'),
        unavailableEnv
      );

      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        error: { code: 'authentication_unavailable', message: 'Service is not ready' },
      });
    }
  );

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

  it('reports not ready when the D1 health query fails', async () => {
    const unavailableEnv = Object.assign(Object.create(testEnv), {
      DB: { prepare: () => { throw new Error('D1 unavailable'); } },
    }) as unknown as Env;
    const response = await worker.fetch(
      new Request('https://keiko.example.test/readyz'),
      unavailableEnv
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: 'internal_error', message: 'Service is not ready' },
    });
  });
});
