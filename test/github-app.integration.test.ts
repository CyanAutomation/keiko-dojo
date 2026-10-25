import { env } from 'cloudflare:workers';
import { generateKeyPairSync } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import {
  GitHubInstallationVerificationError,
  verifySelectedRepositoryInstallation,
  writeGitHubBackup,
} from '../src/integrations/github-app';
import type { SnapshotSession } from '../src/domain/backup-snapshot';

const originalFetch = globalThis.fetch;
let appEnv: Env & { GITHUB_APP_PRIVATE_KEY?: string };
let authPrivateKey: CryptoKey;
let authPublicJwk: JWK;
const authKeyId = 'github-installation-test-key';

function encodeBase64Utf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

beforeAll(async () => {
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  appEnv = Object.create(env) as Env & { GITHUB_APP_PRIVATE_KEY?: string };
  Object.defineProperties(appEnv, {
    GITHUB_APP_PRIVATE_KEY: {
      configurable: true,
      enumerable: true,
      value: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      writable: true,
    },
    GITHUB_APP_ID: { configurable: true, enumerable: true, value: '12345', writable: true },
    GITHUB_APP_INSTALL_URL: {
      configurable: true,
      enumerable: true,
      value: 'https://github.com/apps/keiko-dojo/installations/new',
      writable: true,
    },
  });
  const authKeys = await generateKeyPair('EdDSA', { crv: 'Ed25519' });
  authPrivateKey = authKeys.privateKey;
  authPublicJwk = { ...(await exportJWK(authKeys.publicKey)), alg: 'EdDSA', kid: authKeyId, use: 'sig' };
});

afterAll(() => {
  vi.stubGlobal('fetch', originalFetch);
});

describe('GitHub App selected-repository backup adapter', () => {
  it.each([
    ['placeholder app ID', 'replace-with-github-app-id', 'https://github.com/apps/keiko-dojo/installations/new', 'test-private-key'],
    ['placeholder install URL', '12345', 'https://github.com/apps/replace-keiko-dojo/installations/new', 'test-private-key'],
    ['missing private key', '12345', 'https://github.com/apps/keiko-dojo/installations/new', ''],
  ])('reports the GitHub integration as unconfigured for a %s', async (_label, appId, installUrl, privateKey) => {
    const userId = `unconfigured-github-${crypto.randomUUID()}`;
    const allowRateLimit = { limit: async (_input: { key: string }) => ({ success: true }) };
    const testEnv = Object.assign(Object.create(appEnv), {
      GITHUB_APP_ID: appId,
      GITHUB_APP_INSTALL_URL: installUrl,
      GITHUB_APP_PRIVATE_KEY: privateKey,
      SESSION_READ_LIMITER: allowRateLimit,
      SESSION_WRITE_LIMITER: allowRateLimit,
      BACKUP_WRITE_LIMITER: allowRateLimit,
    }) as Env;
    const priorFetch = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === 'https://auth.example.test/api/auth/jwks') {
        return Response.json({ keys: [authPublicJwk] });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    try {
      const token = await new SignJWT({ appUserId: userId, scope: 'backups:write' })
        .setProtectedHeader({ alg: 'EdDSA', kid: authKeyId })
        .setSubject(userId)
        .setIssuer('https://auth.example.test')
        .setAudience('keiko-dojo-api')
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(authPrivateKey);
      const response = await worker.fetch(new Request('https://keiko.example.test/v1/backups/github-installation', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: '{}',
      }), testEnv);

      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        error: { code: 'internal_error', message: 'GitHub App is not configured' },
      });
      const states = await env.DB.prepare(
        'SELECT state_hash FROM github_installation_states WHERE user_id = ?'
      ).bind(userId).all();
      expect(states.results).toHaveLength(0);
    } finally {
      vi.stubGlobal('fetch', priorFetch);
    }
  });

  it('rejects a placeholder App ID before making GitHub API requests', async () => {
    const previousAppId = appEnv.GITHUB_APP_ID;
    const priorFetch = globalThis.fetch;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    Reflect.set(appEnv, 'GITHUB_APP_ID', 'replace-with-github-app-id');

    try {
      await expect(verifySelectedRepositoryInstallation(appEnv, 731))
        .rejects.toThrow('GitHub App is not configured');
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      Reflect.set(appEnv, 'GITHUB_APP_ID', previousAppId);
      vi.stubGlobal('fetch', priorFetch);
    }
  });

  it('sends a stable User-Agent header on every GitHub API request', async () => {
    const priorFetch = globalThis.fetch;
    const requests: Array<{ url: string; headers: Headers }> = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      requests.push({ url, headers: new Headers(init?.headers) });
      if (url.endsWith('/app/installations/731')) {
        return Response.json({ id: 731, repository_selection: 'selected' });
      }
      if (url.endsWith('/app/installations/731/access_tokens')) {
        return Response.json({ token: 'read-only-install-token' });
      }
      if (url.endsWith('/installation/repositories?per_page=100')) {
        return Response.json({ total_count: 1, repositories: [{
          id: 88, name: 'judo-notes', full_name: 'maki/judo-notes', owner: { login: 'maki' },
        }] });
      }
      throw new Error(`Unexpected GitHub API request: ${url}`);
    });

    try {
      await expect(verifySelectedRepositoryInstallation(appEnv, 731)).resolves.toMatchObject({
        installation_id: 731,
        repository_owner: 'maki',
        repository_name: 'judo-notes',
        repository_id: 88,
      });
      expect(requests).toHaveLength(3);
      expect(requests.every(({ headers }) => headers.get('user-agent') === 'Keiko-Dojo/0.1')).toBe(true);
    } finally {
      vi.stubGlobal('fetch', priorFetch);
    }
  });

  it('logs safe GitHub backup failure details without provider response text', async () => {
    const priorFetch = globalThis.fetch;
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith('/app/installations/731/access_tokens')) {
        return Response.json({ token: 'write-install-token' });
      }
      return Response.json({
        message: 'private provider detail that must not enter logs',
      }, { status: 403 });
    });

    try {
      await expect(writeGitHubBackup(appEnv, {
        user_id: 'safe-backup-diagnostic',
        installation_id: 731,
        repository_owner: 'maki',
        repository_name: 'judo-notes',
        repository_id: 88,
      }, 'snapshot-diagnostic', '2026-10-24T00:00:00.000Z', [{
        id: 'safe-diagnostic-session',
        session_date: '2026-10-24',
        category: 'Technical',
        effort: 3,
        payload: JSON.stringify({
          id: 'safe-diagnostic-session', date: '2026-10-24', effort: 3,
          category: 'Technical', techniques: ['Uchi mata'],
        }),
        revision: 1,
        updated_at: '2026-10-24T00:00:00.000Z',
      }])).rejects.toThrow();

      expect(errorLog).toHaveBeenCalledWith('github_backup_failed', {
        phase: 'session_contents',
        causeName: 'GitHubAppApiError',
        causeCode: null,
        status: 403,
        reason: 'other',
        apiErrorCategory: 'forbidden',
      });
      expect(JSON.stringify(errorLog.mock.calls)).not.toContain('private provider detail');
    } finally {
      errorLog.mockRestore();
      vi.stubGlobal('fetch', priorFetch);
    }
  });

  it('skips a GitHub content commit when the stored Markdown already matches', async () => {
    const priorFetch = globalThis.fetch;
    const requests: Array<{ method: string; url: string }> = [];
    const markdown = [
      '---',
      'id: "unchanged-session"',
      'date: "2026-10-24"',
      'effort: 3',
      'category: "Technical"',
      '---',
      '',
      '# 2026-10-24 - Judo Session: Technical',
      '',
      '## Techniques Practiced',
      '- Ōuchi mata',
      '',
      '## Session Description',
      '',
      '',
      '',
      '## Notes',
      '',
      '',
      '',
    ].join('\n');
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
      requests.push({ method, url });
      if (url.endsWith('/app/installations/731/access_tokens')) {
        return Response.json({ token: 'write-install-token' });
      }
      if (method === 'GET' && url.endsWith('/20261024-matmetrics-unchanged-session.md')) {
        return Response.json({
          sha: 'existing-content-sha',
          encoding: 'base64',
          content: encodeBase64Utf8(markdown),
        });
      }
      throw new Error(`Unexpected GitHub API request: ${url}`);
    });

    try {
      await writeGitHubBackup(appEnv, {
        user_id: 'unchanged-backup-user',
        installation_id: 731,
        repository_owner: 'maki',
        repository_name: 'judo-notes',
        repository_id: 88,
      }, 'snapshot-unchanged', '2026-10-24T00:00:00.000Z', [{
        id: 'unchanged-session',
        session_date: '2026-10-24',
        category: 'Technical',
        effort: 3,
        payload: JSON.stringify({
          id: 'unchanged-session', date: '2026-10-24', effort: 3,
          category: 'Technical', techniques: ['Ōuchi mata'],
        }),
        revision: 1,
        updated_at: '2026-10-24T00:00:00.000Z',
      }]);

      expect(requests).toHaveLength(2);
      expect(requests.some(({ method }) => method === 'PUT')).toBe(false);
    } finally {
      vi.stubGlobal('fetch', priorFetch);
    }
  });

  it('binds a selected-repository callback to its one-time initiating account state', async () => {
    const priorFetch = globalThis.fetch;
    const previousFrontendOrigin = appEnv.MATMETRICS_FRONTEND_URL;
    Reflect.set(appEnv, 'MATMETRICS_FRONTEND_URL', 'https://matmetrics.example.test');
    const allowRateLimit = { limit: async (_input: { key: string }) => ({ success: true }) };
    const testEnv = Object.assign(Object.create(appEnv), {
      SESSION_READ_LIMITER: allowRateLimit,
      SESSION_WRITE_LIMITER: allowRateLimit,
      BACKUP_WRITE_LIMITER: allowRateLimit,
    }) as Env;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === 'https://auth.example.test/api/auth/jwks') {
        return Response.json({ keys: [authPublicJwk] });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    try {
    const started = await worker.fetch(new Request('https://keiko.example.test/v1/backups/github-installation', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await new SignJWT({
          appUserId: 'install-user', scope: 'backups:write',
        })
          .setProtectedHeader({ alg: 'EdDSA', kid: authKeyId })
          .setSubject('install-user')
          .setIssuer('https://auth.example.test')
          .setAudience('keiko-dojo-api')
          .setIssuedAt()
          .setExpirationTime('5m')
          .sign(authPrivateKey)}`,
        'content-type': 'application/json',
      },
      body: '{}',
    }), testEnv);
    expect(started.status).toBe(201);
    const startBody = await started.json() as { url: string };
    const installUrl = new URL(startBody.url);
    const state = installUrl.searchParams.get('state')!;
    const githubCalls: string[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      githubCalls.push(url);
      if (url === 'https://auth.example.test/api/auth/jwks') {
        return Response.json({ keys: [authPublicJwk] });
      }
      if (url.endsWith('/app/installations/731')) {
        return Response.json({ id: 731, repository_selection: 'selected' });
      }
      if (url.endsWith('/app/installations/731/access_tokens')) {
        const body = JSON.parse(String(init?.body));
        if (body.permissions.contents === 'read') return Response.json({ token: 'read-install-token' });
      }
      if (url.endsWith('/installation/repositories?per_page=100')) {
        return Response.json({ total_count: 1, repositories: [{
          id: 88, name: 'judo-notes', full_name: 'maki/judo-notes', owner: { login: 'maki' },
        }] });
      }
      throw new Error(`Unexpected GitHub API request: ${url}`);
    });
    const callbackUrl = new URL('/v1/backups/github-installation/callback', 'https://keiko.example.test');
    callbackUrl.searchParams.set('state', state);
    callbackUrl.searchParams.set('installation_id', '731');
      const callback = await worker.fetch(new Request(callbackUrl), testEnv);
      expect(callback.status).toBe(302);
      expect(callback.headers.get('location')).toBe('https://matmetrics.example.test/settings?githubBackup=connected');
      const stateHash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(state))))
        .map((value) => value.toString(16).padStart(2, '0')).join('');
      const saved = await env.DB.prepare(
        'SELECT user_id, repository_owner, repository_name FROM github_installations WHERE user_id = ?'
      ).bind('install-user').first();
      expect(saved).toEqual({
        user_id: 'install-user', repository_owner: 'maki', repository_name: 'judo-notes',
      });
      const consumed = await env.DB.prepare(
        'SELECT consumed_at FROM github_installation_states WHERE state_hash = ?'
      ).bind(stateHash).first<{ consumed_at: string | null }>();
      expect(consumed?.consumed_at).toBeTruthy();
      const callCountAfterSuccess = githubCalls.length;
      const replay = await worker.fetch(new Request(callbackUrl), testEnv);
      expect(replay.headers.get('location')).toBe('https://matmetrics.example.test/settings?githubBackup=failed');
      expect(githubCalls).toHaveLength(callCountAfterSuccess);
    } finally {
      vi.stubGlobal('fetch', priorFetch);
      Reflect.set(appEnv, 'MATMETRICS_FRONTEND_URL', previousFrontendOrigin);
    }
  });

  it('uses one timestamp to validate and consume an OAuth state near expiry', async () => {
    const priorFetch = globalThis.fetch;
    const previousFrontendOrigin = appEnv.MATMETRICS_FRONTEND_URL;
    const state = crypto.randomUUID() + crypto.randomUUID();
    const userId = `expiry-race-${crypto.randomUUID()}`;
    const stateHash = Array.from(new Uint8Array(await crypto.subtle.digest(
      'SHA-256', new TextEncoder().encode(state)
    ))).map((value) => value.toString(16).padStart(2, '0')).join('');
    const selectTime = '2026-10-18T10:00:00.000Z';
    const updateTime = '2026-10-18T10:00:01.000Z';
    await env.DB.prepare(
      `INSERT INTO github_installation_states (state_hash, user_id, created_at, expires_at)
       VALUES (?, ?, ?, ?)`
    ).bind(stateHash, userId, selectTime, '2026-10-18T10:00:00.500Z').run();

    Reflect.set(appEnv, 'MATMETRICS_FRONTEND_URL', 'https://matmetrics.example.test');
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith('/app/installations/731')) {
        return Response.json({ id: 731, repository_selection: 'selected' });
      }
      if (url.endsWith('/app/installations/731/access_tokens')) {
        return Response.json({ token: 'read-install-token' });
      }
      if (url.endsWith('/installation/repositories?per_page=100')) {
        return Response.json({ total_count: 1, repositories: [{
          id: 88, name: 'judo-notes', full_name: 'maki/judo-notes', owner: { login: 'maki' },
        }] });
      }
      throw new Error(`Unexpected GitHub API request: ${url}`);
    });
    const isoTimestamp = vi.spyOn(Date.prototype, 'toISOString')
      .mockImplementationOnce(() => selectTime)
      .mockImplementationOnce(() => updateTime);

    try {
      const callbackUrl = new URL('/v1/backups/github-installation/callback', 'https://keiko.example.test');
      callbackUrl.searchParams.set('state', state);
      callbackUrl.searchParams.set('installation_id', '731');
      const callback = await worker.fetch(new Request(callbackUrl), appEnv);

      expect(callback.headers.get('location')).toBe('https://matmetrics.example.test/settings?githubBackup=connected');
      expect(isoTimestamp).toHaveBeenCalledTimes(1);
    } finally {
      isoTimestamp.mockRestore();
      vi.stubGlobal('fetch', priorFetch);
      Reflect.set(appEnv, 'MATMETRICS_FRONTEND_URL', previousFrontendOrigin);
    }
  });

  it('accepts GitHub-generated PKCS#1 RSA private keys', async () => {
    const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 })
      .privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
    const previousPrivateKey = appEnv.GITHUB_APP_PRIVATE_KEY;
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      calls.push(url);
      if (url === 'https://api.github.com/app/installations/731') {
        return Response.json({ id: 731, repository_selection: 'selected' });
      }
      if (url === 'https://api.github.com/app/installations/731/access_tokens') {
        return Response.json({ token: 'read-only-install-token' });
      }
      if (url === 'https://api.github.com/installation/repositories?per_page=100') {
        return Response.json({
          total_count: 1,
          repositories: [{ id: 88, name: 'judo-notes', full_name: 'maki/judo-notes', owner: { login: 'maki' } }],
        });
      }
      throw new Error(`Unexpected GitHub API request: ${url}`);
    });

    Reflect.set(appEnv, 'GITHUB_APP_PRIVATE_KEY', privateKey);
    try {
      await expect(verifySelectedRepositoryInstallation(appEnv, 731)).resolves.toMatchObject({
        installation_id: 731,
        repository_owner: 'maki',
        repository_name: 'judo-notes',
        repository_id: 88,
      });
      expect(calls).toHaveLength(3);
    } finally {
      Reflect.set(appEnv, 'GITHUB_APP_PRIVATE_KEY', previousPrivateKey);
    }
  });

  it('keeps a safe phase and HTTP status for GitHub installation failures', async () => {
    vi.stubGlobal('fetch', async () => Response.json({ message: 'sensitive provider response' }, { status: 401 }));

    await expect(verifySelectedRepositoryInstallation(appEnv, 731)).rejects.toMatchObject({
      phase: 'installation_lookup_response',
      status: 401,
      apiErrorCategory: 'other',
    } satisfies Partial<GitHubInstallationVerificationError>);
  });

  it('classifies a GitHub integration access denial without retaining its body', async () => {
    vi.stubGlobal('fetch', async () => Response.json({
      message: 'Resource not accessible by integration. Check the installation permissions.',
      errors: [{ message: 'private provider detail' }],
    }, { status: 403 }));

    const failure = await verifySelectedRepositoryInstallation(appEnv, 731).catch((error: unknown) => error);
    if (!(failure instanceof GitHubInstallationVerificationError)) {
      throw new Error('Expected a safe GitHub installation verification failure');
    }
    expect(failure).toMatchObject({
      phase: 'installation_lookup_response',
      status: 403,
      apiErrorCategory: 'integration_access_denied',
    });
    expect(failure.message).toBe('GitHub installation verification failed');
  });

  it('classifies GitHub transport failures without retaining their message', async () => {
    vi.stubGlobal('fetch', async () => {
      const cause = Object.assign(new Error('private network message'), { code: 'ECONNRESET' });
      throw new TypeError('private transport detail', { cause });
    });

    const failure = await verifySelectedRepositoryInstallation(appEnv, 731).catch((error: unknown) => error);
    if (!(failure instanceof GitHubInstallationVerificationError)) {
      throw new Error('Expected a safe GitHub installation verification failure');
    }
    expect(failure).toMatchObject({
      phase: 'installation_lookup_request',
      causeName: 'TypeError',
      causeCode: 'ECONNRESET',
      reason: 'other',
    });
    expect(failure.message).toBe('GitHub installation verification failed');
  });

  it('records a rejected redirect without storing its query string', async () => {
    vi.stubGlobal('fetch', async () => new Response(null, {
      status: 302,
      headers: { location: 'https://api.github.com/login?private=not-logged' },
    }));

    const failure = await verifySelectedRepositoryInstallation(appEnv, 731).catch((error: unknown) => error);
    if (!(failure instanceof GitHubInstallationVerificationError)) {
      throw new Error('Expected a safe GitHub installation verification failure');
    }
    expect(failure).toMatchObject({
      phase: 'installation_lookup_request',
      status: 302,
      reason: 'redirect_rejected',
      redirectOrigin: 'https://api.github.com',
      redirectPath: '/login',
    });
    expect(failure.message).toBe('GitHub installation verification failed');
  });

  it('requires selected access to exactly one repository and scopes write tokens to it', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      calls.push({ url, init });
      if (url === 'https://api.github.com/app/installations/731') {
        return Response.json({ id: 731, repository_selection: 'selected' });
      }
      if (url === 'https://api.github.com/app/installations/731/access_tokens') {
        const body = JSON.parse(String(init?.body));
        if (body.permissions.contents === 'read') return Response.json({ token: 'read-only-install-token' });
        expect(body).toEqual({ repositories: ['judo-notes'], permissions: { contents: 'write' } });
        return Response.json({ token: 'scoped-write-token' });
      }
      if (url === 'https://api.github.com/installation/repositories?per_page=100') {
        return Response.json({
          total_count: 1,
          repositories: [{ id: 88, name: 'judo-notes', full_name: 'maki/judo-notes', owner: { login: 'maki' } }],
        });
      }
      if (url.includes('/contents/data/')) {
        if (init?.method === 'PUT') return Response.json({ content: { sha: 'saved' } });
        if (url.endsWith('/20261016-matmetrics-s-2.md')) return Response.json({ sha: 'existing-session-sha' });
        return new Response(null, { status: 404 });
      }
      throw new Error(`Unexpected GitHub API request: ${url}`);
    });

    const installation = await verifySelectedRepositoryInstallation(appEnv, 731);
    expect(installation).toEqual({
      installation_id: 731,
      repository_owner: 'maki',
      repository_name: 'judo-notes',
      repository_id: 88,
    });
    const sessions: SnapshotSession[] = [
      {
        id: 's-1', session_date: '2026-10-17', category: 'Technical', effort: 3,
        payload: JSON.stringify({
          id: 's-1', date: '2026-10-17', effort: 3, category: 'Technical',
          duration: 75, videoUrl: 'https://example.test/video.webm',
          techniques: ['Uchi mata'], description: 'Entry practice', notes: 'private training note',
        }),
        revision: 1, updated_at: '2026-10-17T00:00:00.000Z',
      },
      {
        id: 's-2', session_date: '2026-10-16', category: 'Randori', effort: 4,
        payload: JSON.stringify({
          id: 's-2', date: '2026-10-16', effort: 4, category: 'Randori',
          techniques: ['Randori drills\n# injected heading'],
          description: 'Warm-up\n---\n# Injected heading\n<script>alert(1)</script>',
          notes: '[link](https://evil.test)\n- injected list\n```html',
        }),
        revision: 2, updated_at: '2026-10-17T00:00:00.000Z',
      },
    ];
    await writeGitHubBackup(appEnv, { user_id: 'user-1', ...installation }, 'snapshot-1', '2026-10-17T00:00:00.000Z', sessions);

    const readRequest = calls.find((call) => call.url.endsWith('/access_tokens'))!;
    expect(readRequest.init?.redirect).toBe('manual');
    const uploads = calls.filter((call) => call.init?.method === 'PUT');
    expect(uploads).toHaveLength(2);
    expect(uploads.map((upload) => upload.url)).toEqual([
      expect.stringContaining('/contents/data/2026/10/20261017-matmetrics-s-1.md'),
      expect.stringContaining('/contents/data/2026/10/20261016-matmetrics-s-2.md'),
    ]);
    const upload = uploads[0]!;
    expect(upload).toBeDefined();
    const uploadBody = JSON.parse(String(upload.init?.body));
    const markdown = Buffer.from(uploadBody.content, 'base64').toString('utf8');
    expect(markdown).toBe([
      '---',
      'id: "s-1"',
      'date: "2026-10-17"',
      'effort: 3',
      'category: "Technical"',
      'duration: 75',
      'videoUrl: "https://example.test/video.webm"',
      '---',
      '',
      '# 2026-10-17 - Judo Session: Technical',
      '',
      '## Techniques Practiced',
      '- Uchi mata',
      '',
      '## Session Description',
      '',
      'Entry practice',
      '',
      '## Notes',
      '',
      'private training note',
      '',
    ].join('\n'));
    expect(uploadBody.message).toContain('snapshot-1');
    expect(JSON.parse(String(uploads[1]?.init?.body))).toMatchObject({
      sha: 'existing-session-sha',
    });
    const secondMarkdown = Buffer.from(
      JSON.parse(String(uploads[1]?.init?.body)).content,
      'base64'
    ).toString('utf8');
    expect(secondMarkdown).toContain('- Randori drills \\# injected heading');
    expect(secondMarkdown).toContain('Warm\\-up\n\\-\\-\\-\n\\# Injected heading\n&lt;script&gt;alert\\(1\\)&lt;/script&gt;');
    expect(secondMarkdown).toContain('\\[link\\]\\(https://evil\\.test\\)\n\\- injected list\n\\`\\`\\`html');
  });

  it('rejects malformed stored session payloads before writing repository contents', async () => {
    const priorFetch = globalThis.fetch;
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const tokenUrl = 'https://api.github.com/app/installations/731/access_tokens';
    const calls: Array<{ url: string; method: string }> = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      calls.push({ url, method: init?.method ?? 'GET' });
      if (url === tokenUrl && init?.method === 'POST') {
        return Response.json({ token: 'scoped-write-token' });
      }
      throw new Error(`Unexpected GitHub API request: ${url}`);
    });
    const invalidSession: SnapshotSession = {
      id: 'broken-session',
      session_date: '2026-10-17',
      category: 'Technical',
      effort: 3,
      payload: '{invalid-json',
      revision: 1,
      updated_at: '2026-10-17T00:00:00.000Z',
    };

    try {
      await expect(writeGitHubBackup(
        appEnv,
        {
          user_id: 'user-1',
          installation_id: 731,
          repository_owner: 'maki',
          repository_name: 'judo-notes',
          repository_id: 88,
        },
        'snapshot-1',
        '2026-10-17T00:00:00.000Z',
        [invalidSession]
      )).rejects.toThrow('Stored session payload is invalid');
      expect(calls).toEqual([]);
      expect(errorLog).not.toHaveBeenCalled();
    } finally {
      errorLog.mockRestore();
      vi.stubGlobal('fetch', priorFetch);
    }
  });

  it('rejects empty techniques before requesting GitHub access', async () => {
    const priorFetch = globalThis.fetch;
    const tokenUrl = 'https://api.github.com/app/installations/731/access_tokens';
    const calls: Array<{ url: string; method: string }> = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      calls.push({ url, method: init?.method ?? 'GET' });
      if (url === tokenUrl && init?.method === 'POST') {
        return Response.json({ token: 'scoped-write-token' });
      }
      throw new Error(`Unexpected GitHub API request: ${url}`);
    });
    const invalidSession: SnapshotSession = {
      id: 'empty-technique-session',
      session_date: '2026-10-17',
      category: 'Technical',
      effort: 3,
      payload: JSON.stringify({
        id: 'empty-technique-session',
        date: '2026-10-17',
        category: 'Technical',
        effort: 3,
        techniques: ['   '],
      }),
      revision: 1,
      updated_at: '2026-10-17T00:00:00.000Z',
    };

    try {
      await expect(writeGitHubBackup(
        appEnv,
        {
          user_id: 'user-1',
          installation_id: 731,
          repository_owner: 'maki',
          repository_name: 'judo-notes',
          repository_id: 88,
        },
        'snapshot-1',
        '2026-10-17T00:00:00.000Z',
        [invalidSession]
      )).rejects.toThrow('Stored session payload is invalid');
      expect(calls).toEqual([]);
    } finally {
      vi.stubGlobal('fetch', priorFetch);
    }
  });

  it('rejects GitHub App installations with all-repository access or more than one selected repository', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith('/app/installations/732')) {
        return Response.json({ id: 732, repository_selection: 'all' });
      }
      if (url.endsWith('/app/installations/733')) {
        return Response.json({ id: 733, repository_selection: 'selected' });
      }
      if (url.endsWith('/access_tokens')) return Response.json({ token: 'read-token' });
      if (url.includes('/installation/repositories')) {
        return Response.json({ total_count: 2, repositories: [{}, {}] });
      }
      throw new Error(`Unexpected GitHub API request: ${url}`);
    });
    await expect(verifySelectedRepositoryInstallation(appEnv, 732)).rejects.toThrow();
    await expect(verifySelectedRepositoryInstallation(appEnv, 733)).rejects.toThrow();
  });
});
