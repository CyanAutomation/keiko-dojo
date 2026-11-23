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

  it('replays the original creation result for an equivalent idempotent request', async () => {
    const key = `phase-2b-${crypto.randomUUID()}`;
    const session = { ...testSession, id: `idempotent-${crypto.randomUUID()}` };
    const first = await call('/v1/sessions', 'idempotent-user', {
      method: 'POST',
      headers: { 'idempotency-key': key },
      body: JSON.stringify(session),
    });
    expect(first.status).toBe(201);
    const originalRecord = await first.json();
    const originalEtag = first.headers.get('etag');

    const replay = await call('/v1/sessions', 'idempotent-user', {
      method: 'POST',
      headers: { 'idempotency-key': key },
      body: JSON.stringify({
        duration: session.duration,
        notes: session.notes,
        description: session.description,
        category: session.category,
        effort: session.effort,
        techniques: session.techniques,
        date: session.date,
        id: session.id,
      }),
    });
    expect(replay.status).toBe(201);
    expect(await replay.json()).toEqual(originalRecord);
    expect(replay.headers.get('etag')).toBe(originalEtag);

    const updated = await call(`/v1/sessions/${session.id}`, 'idempotent-user', {
      method: 'PUT',
      headers: { 'if-match': originalEtag! },
      body: JSON.stringify({ ...session, notes: 'later edit' }),
    });
    expect(updated.status).toBe(200);
    const updatedEtag = updated.headers.get('etag');
    const deleted = await call(`/v1/sessions/${session.id}`, 'idempotent-user', {
      method: 'DELETE',
      headers: { 'if-match': updatedEtag! },
    });
    expect(deleted.status).toBe(204);

    const historicalReplay = await call('/v1/sessions', 'idempotent-user', {
      method: 'POST',
      headers: { 'idempotency-key': key },
      body: JSON.stringify(session),
    });
    expect(historicalReplay.status).toBe(201);
    expect(await historicalReplay.json()).toEqual(originalRecord);
    expect(historicalReplay.headers.get('etag')).toBe(originalEtag);
  });

  it('distinguishes idempotency-key reuse from a session ID conflict', async () => {
    const key = `phase-2b-${crypto.randomUUID()}`;
    const session = { ...testSession, id: `idempotent-${crypto.randomUUID()}` };
    const first = await call('/v1/sessions', 'idempotent-conflict-user', {
      method: 'POST',
      headers: { 'idempotency-key': key },
      body: JSON.stringify(session),
    });
    expect(first.status).toBe(201);

    const changedPayload = await call('/v1/sessions', 'idempotent-conflict-user', {
      method: 'POST',
      headers: { 'idempotency-key': key },
      body: JSON.stringify({ ...session, notes: 'different logical request' }),
    });
    expect(changedPayload.status).toBe(409);
    expect(await changedPayload.json()).toMatchObject({
      error: { code: 'idempotency_key_reuse' },
    });

    const differentKey = await call('/v1/sessions', 'idempotent-conflict-user', {
      method: 'POST',
      headers: { 'idempotency-key': `phase-2b-${crypto.randomUUID()}` },
      body: JSON.stringify(session),
    });
    expect(differentKey.status).toBe(409);
    expect(await differentKey.json()).toMatchObject({
      error: { code: 'session_conflict' },
    });
  });

  it('creates exactly one record for concurrent identical requests', async () => {
    const key = `phase-2b-${crypto.randomUUID()}`;
    const session = { ...testSession, id: `idempotent-${crypto.randomUUID()}` };
    const makeRequest = () => call('/v1/sessions', 'idempotent-race-user', {
      method: 'POST',
      headers: { 'idempotency-key': key },
      body: JSON.stringify(session),
    });

    const [left, right] = await Promise.all([makeRequest(), makeRequest()]);
    expect([left.status, right.status]).toEqual([201, 201]);
    expect(await left.json()).toEqual(await right.json());
    expect(left.headers.get('etag')).toBe(right.headers.get('etag'));
    expect(await env.DB.prepare(
      'SELECT COUNT(*) AS count FROM sessions WHERE user_id = ? AND id = ?'
    ).bind('idempotent-race-user', session.id).first()).toMatchObject({ count: 1 });
  });

  it('does not allow concurrent different payloads to share a key', async () => {
    const key = `phase-2b-${crypto.randomUUID()}`;
    const leftSession = { ...testSession, id: `idempotent-left-${crypto.randomUUID()}` };
    const rightSession = { ...testSession, id: `idempotent-right-${crypto.randomUUID()}` };
    const [left, right] = await Promise.all([
      call('/v1/sessions', 'idempotent-payload-race-user', {
        method: 'POST', headers: { 'idempotency-key': key }, body: JSON.stringify(leftSession),
      }),
      call('/v1/sessions', 'idempotent-payload-race-user', {
        method: 'POST', headers: { 'idempotency-key': key },
        body: JSON.stringify({ ...rightSession, notes: 'other payload' }),
      }),
    ]);

    expect([left.status, right.status].sort()).toEqual([201, 409]);
    const conflict = left.status === 409 ? left : right;
    expect(await conflict.json()).toMatchObject({
      error: { code: 'idempotency_key_reuse' },
    });
    expect(await env.DB.prepare(
      'SELECT COUNT(*) AS count FROM sessions WHERE user_id = ?'
    ).bind('idempotent-payload-race-user').first()).toMatchObject({ count: 1 });
  });

  it('rolls back the session and ledger when the D1 batch fails', async () => {
    const key = `phase-2b-${crypto.randomUUID()}`;
    const userId = `idempotent-failed-write-${crypto.randomUUID()}`;
    const id = `failed-write-${crypto.randomUUID()}`;
    const triggerName = `fail_idempotent_create_${crypto.randomUUID().replaceAll('-', '')}`;
    await env.DB.prepare(
      `CREATE TRIGGER ${triggerName} BEFORE INSERT ON sessions
       WHEN NEW.id = '${id}'
       BEGIN SELECT RAISE(ABORT, 'simulated D1 failure'); END`
    ).run();

    try {
      const response = await call('/v1/sessions', userId, {
        method: 'POST',
        headers: { 'idempotency-key': key },
        body: JSON.stringify({ ...testSession, id }),
      });
      expect(response.status).toBe(500);
      const body = await response.text();
      expect(body).not.toContain('simulated D1 failure');
      expect(body).not.toContain('INSERT INTO');
      expect(await env.DB.prepare(
        'SELECT COUNT(*) AS count FROM sessions WHERE user_id = ? AND id = ?'
      ).bind(userId, id).first()).toMatchObject({ count: 0 });
      expect(await env.DB.prepare(
        'SELECT COUNT(*) AS count FROM session_create_idempotency WHERE user_id = ? AND idempotency_key = ?'
      ).bind(userId, key).first()).toMatchObject({ count: 0 });
    } finally {
      await env.DB.prepare(`DROP TRIGGER IF EXISTS ${triggerName}`).run();
    }
  });

  it('allows the same key for different users and rejects malformed keys', async () => {
    const key = `phase-2b-${crypto.randomUUID()}`;
    const session = { ...testSession, id: `idempotent-${crypto.randomUUID()}` };
    const [left, right] = await Promise.all([
      call('/v1/sessions', 'idempotent-user-a', {
        method: 'POST', headers: { 'idempotency-key': key }, body: JSON.stringify(session),
      }),
      call('/v1/sessions', 'idempotent-user-b', {
        method: 'POST', headers: { 'idempotency-key': key }, body: JSON.stringify(session),
      }),
    ]);
    expect(left.status).toBe(201);
    expect(right.status).toBe(201);
    expect(left.headers.get('etag')).not.toBe(right.headers.get('etag'));

    const maximumLengthKey = 'a'.repeat(128);
    const maximumLength = await call('/v1/sessions', 'maximum-key-user', {
      method: 'POST',
      headers: { 'idempotency-key': maximumLengthKey },
      body: JSON.stringify({ ...session, id: 'maximum-key-' + crypto.randomUUID() }),
    });
    expect(maximumLength.status).toBe(201);

    const malformed = await call('/v1/sessions', 'malformed-key-user', {
      method: 'POST',
      headers: { 'idempotency-key': `bad key ${crypto.randomUUID()}` },
      body: JSON.stringify({ ...session, id: `malformed-${crypto.randomUUID()}` }),
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({
      error: { code: 'bad_request' },
    });

    const oversized = await call('/v1/sessions', 'malformed-key-user', {
      method: 'POST',
      headers: { 'idempotency-key': 'a'.repeat(129) },
      body: JSON.stringify({ ...session, id: `oversized-${crypto.randomUUID()}` }),
    });
    expect(oversized.status).toBe(400);
  });

  it('reuses server-generated IDs for keyed creates without an ID', async () => {
    const key = `phase-2b-${crypto.randomUUID()}`;
    const { id: _ignored, ...sessionWithoutId } = testSession;
    const makeRequest = () => call('/v1/sessions', 'generated-id-user', {
      method: 'POST',
      headers: { 'idempotency-key': key },
      body: JSON.stringify(sessionWithoutId),
    });

    const first = await makeRequest();
    const replay = await makeRequest();
    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    const originalRecord = await first.json();
    expect(await replay.json()).toEqual(originalRecord);
    expect(replay.headers.get('etag')).toBe(first.headers.get('etag'));
  });

  it('does not record an invalid create and does not re-trigger GitHub sync on replay', async () => {
    const invalidKey = `phase-2b-${crypto.randomUUID()}`;
    const session = { ...testSession, id: `idempotent-${crypto.randomUUID()}` };
    const invalid = await call('/v1/sessions', 'idempotent-validation-user', {
      method: 'POST',
      headers: { 'idempotency-key': invalidKey },
      body: JSON.stringify({ ...session, effort: 9 }),
    });
    expect(invalid.status).toBe(400);

    const corrected = await call('/v1/sessions', 'idempotent-validation-user', {
      method: 'POST', headers: { 'idempotency-key': invalidKey }, body: JSON.stringify(session),
    });
    expect(corrected.status).toBe(201);

    const userId = `idempotent-sync-user-${crypto.randomUUID()}`;
    await env.DB.prepare(
      `INSERT INTO github_installations
       (user_id, installation_id, repository_owner, repository_name, repository_id, granted_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(userId, 991, 'test-owner', 'test-repo', 991, new Date().toISOString()).run();
    const syncKey = `phase-2b-${crypto.randomUUID()}`;
    const syncSession = { ...testSession, id: `idempotent-${crypto.randomUUID()}` };
    const syncRequest = () => call('/v1/sessions', userId, {
      method: 'POST', headers: { 'idempotency-key': syncKey }, body: JSON.stringify(syncSession),
    });
    expect((await syncRequest()).status).toBe(201);
    const initialSyncState = await env.DB.prepare(
      'SELECT generation FROM github_session_sync_state WHERE user_id = ?'
    ).bind(userId).first<{ generation: number }>();
    expect(initialSyncState?.generation).toBe(1);
    expect((await syncRequest()).status).toBe(201);
    const replaySyncState = await env.DB.prepare(
      'SELECT generation FROM github_session_sync_state WHERE user_id = ?'
    ).bind(userId).first<{ generation: number }>();
    expect(replaySyncState?.generation).toBe(1);
  });
