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

  // Contract: docs/session-contract.md, Validation and normalization; malformed bodies are bad_request.
  it('rejects a malformed Content-Length before creating a session', async () => {
    const userId = `malformed-content-length-${crypto.randomUUID()}`;
    const sessionId = `malformed-content-length-${crypto.randomUUID()}`;
    const response = await call('/v1/sessions', userId, {
      method: 'POST',
      headers: { 'content-length': 'not-a-number' },
      body: JSON.stringify({ ...testSession, id: sessionId }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'bad_request' } });
    expect(await env.DB.prepare('SELECT id FROM sessions WHERE user_id = ? AND id = ?')
      .bind(userId, sessionId).first()).toBeNull();
  });

  it('authenticates MCP requests before parsing their body', async () => {
    const response = await fetchWorker(
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
    const unauthorized = await fetchWorker(
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
      await fetchWorker(new Request('https://keiko.example.test/v1/sessions', {
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
    const response = await fetchWorker(
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
      const response = await fetchWorker(
        new Request('https://keiko.example.test/readyz'),
        unavailableEnv
      );

      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        error: { code: 'authentication_unavailable', message: 'Service is not ready' },
      });
    }
  );

  // Contract: docs/decisions/0002-identity-and-revocation.md, Key management and revocation.
  it.each([
    ['a non-200 response', 'jwks-failure'],
    ['a transport failure', 'jwks-network-failure'],
  ])('reports JWKS %s as authentication unavailable', async (_failure, jwksPath) => {
    const unavailableEnv = Object.assign(Object.create(testEnv), {
      AUTH_JWKS_URL: `${issuer}/${jwksPath}`,
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
    const response = await fetchWorker(
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
    const response = await fetchWorker(
      new Request('https://keiko.example.test/readyz'),
      unavailableEnv
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: 'internal_error', message: 'Service is not ready' },
    });
  });