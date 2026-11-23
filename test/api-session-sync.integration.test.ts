import { env } from 'cloudflare:workers';
import { expect, it, vi } from 'vitest';
import { authenticateRequest } from '../src/auth/bearer-auth';
import worker from '../src/index';
import { processGitHubSessionSyncMessage } from '../src/http/github-sync';
import { credentialBearingVideoUrl } from './helpers';
import { createApiHarness, fetchWorker } from './api-harness';
import { waitForTrackedExecutionContexts } from './execution-contexts';

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

  it.each([
    '/v1/sessions?limit=0',
    '/v1/sessions?from=2026-02-30',
    '/v1/sessions?from=2026-12-01&to=2026-01-01',
    '/v1/sessions?category=unknown',
    '/v1/sessions?effort=0',
    '/v1/sessions?cursor=' + 'a'.repeat(513),
  ])('rejects invalid session list filters: %s', async (path) => {
    const response = await call(path, 'invalid-filter-' + crypto.randomUUID());
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: 'bad_request', message: 'Invalid list filters' },
    });
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

  it('returns before background sync dispatch finishes', async () => {
    const userId = `session-sync-wait-until-${crypto.randomUUID()}`;
    const sessionId = 'wait-until-sync-dispatch';
    await env.DB.prepare(
      `INSERT INTO github_installations
       (user_id, installation_id, repository_owner, repository_name, repository_id, granted_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(userId, 932, 'CyanAutomation', 'matmetrics', 932, new Date().toISOString()).run();
    let backgroundSessionSyncDispatchFinished = false;
    let signalDispatchStarted!: () => void;
    const dispatchStarted = new Promise<void>((resolve) => {
      signalDispatchStarted = resolve;
    });
    const send = vi.fn(async () => {
      signalDispatchStarted();
      await new Promise<void>((resolve) => setTimeout(resolve, 75));
      backgroundSessionSyncDispatchFinished = true;
    });
    const requestEnv = Object.assign(Object.create(testEnv), {
      BACKUP_QUEUE: { send },
    }) as Env;

    try {
      const response = await call('/v1/sessions', userId, {
        method: 'POST',
        body: JSON.stringify({ ...testSession, id: sessionId }),
      }, {}, requestEnv);

      await dispatchStarted;
      expect(response.status).toBe(201);
      expect(send).toHaveBeenCalledOnce();
      expect(backgroundSessionSyncDispatchFinished).toBe(false);

      await waitForTrackedExecutionContexts();
      expect(backgroundSessionSyncDispatchFinished).toBe(true);
    } finally {
      try {
        await waitForTrackedExecutionContexts();
      } finally {
        await env.DB.batch([
          env.DB.prepare(
            'DELETE FROM session_create_idempotency WHERE user_id = ? AND session_id = ?'
          ).bind(userId, sessionId),
          env.DB.prepare(
            'DELETE FROM github_session_sync_state WHERE user_id = ?'
          ).bind(userId),
          env.DB.prepare(
            'DELETE FROM github_installations WHERE user_id = ?'
          ).bind(userId),
          env.DB.prepare(
            'DELETE FROM sessions WHERE user_id = ? AND id = ?'
          ).bind(userId, sessionId),
        ]);
      }
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
