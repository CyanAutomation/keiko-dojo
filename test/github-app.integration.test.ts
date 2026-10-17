import { env } from 'cloudflare:workers';
import { generateKeyPairSync } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { verifySelectedRepositoryInstallation, writeGitHubBackup } from '../src/integrations/github-app';
import type { SnapshotSession } from '../src/http/backups';

const appEnv = env as unknown as Env & { GITHUB_APP_PRIVATE_KEY?: string };
const originalFetch = globalThis.fetch;
let previousKey: string | undefined;
let authPrivateKey: CryptoKey;
let authPublicJwk: JWK;
const authKeyId = 'github-installation-test-key';

beforeAll(async () => {
  previousKey = appEnv.GITHUB_APP_PRIVATE_KEY;
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  appEnv.GITHUB_APP_PRIVATE_KEY = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  Reflect.set(appEnv, 'GITHUB_APP_ID', '12345');
  const authKeys = await generateKeyPair('EdDSA', { crv: 'Ed25519' });
  authPrivateKey = authKeys.privateKey;
  authPublicJwk = { ...(await exportJWK(authKeys.publicKey)), alg: 'EdDSA', kid: authKeyId, use: 'sig' };
});

afterAll(() => {
  appEnv.GITHUB_APP_PRIVATE_KEY = previousKey;
  vi.stubGlobal('fetch', originalFetch);
});

describe('GitHub App selected-repository backup adapter', () => {
  it('binds a selected-repository callback to its one-time initiating account state', async () => {
    const priorFetch = globalThis.fetch;
    const previousFrontendOrigin = appEnv.MATMETRICS_FRONTEND_URL;
    Reflect.set(appEnv, 'MATMETRICS_FRONTEND_URL', 'https://matmetrics.example.test');
    const allowRateLimit = { limit: async (_input: { key: string }) => ({ success: true }) };
    const testEnv = Object.assign(Object.create(env), {
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
    expect(readRequest.init?.redirect).toBe('error');
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
