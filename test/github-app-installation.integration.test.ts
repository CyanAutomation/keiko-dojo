import { generateKeyPairSync } from 'node:crypto';
import { env } from 'cloudflare:workers';
import { expect, it, vi } from 'vitest';
import worker from '../src/index';
import { processGitHubOperationMessage } from '../src/http/github-operations';
import { processGitHubSessionSyncMessage } from '../src/http/github-sync';
import { dispatchPendingGitHubSessionSyncs } from '../src/application/github-session-sync-queue';
import {
  createTestToken,
  credentialBearingVideoUrl,
  testAuthIssuer,
} from './helpers';
import {
  appEnv,
  authPrivateKey,
  authPublicJwk,
  encodeBase64Utf8,
} from './github-app-test-context';
import {
  checkSelectedGitHubRepository,
  GitHubInstallationVerificationError,
  listSelectedGitHubSessionMarkdown,
  updateSelectedGitHubMarkdown,
  verifySelectedRepositoryInstallation,
  syncGitHubSessionMarkdown,
  type GitHubSessionRow,
} from '../src/integrations/github-app';

  it('binds a selected-repository callback to its one-time initiating account state', async () => {
    const priorFetch = globalThis.fetch;
    const previousFrontendOrigin = appEnv.MATMETRICS_FRONTEND_URL;
    Reflect.set(appEnv, 'MATMETRICS_FRONTEND_URL', 'https://matmetrics.example.test');
    const allowRateLimit = { limit: async (_input: { key: string }) => ({ success: true }) };
    const testEnv = Object.assign(Object.create(appEnv), {
      SESSION_READ_LIMITER: allowRateLimit,
      SESSION_WRITE_LIMITER: allowRateLimit,
      BACKUP_WRITE_LIMITER: allowRateLimit,
      BACKUP_QUEUE: { send: vi.fn(async (_message: unknown, _options?: unknown) => {}) },
    }) as Env;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === `${testAuthIssuer}/api/auth/jwks`) {
        return Response.json({ keys: [authPublicJwk] });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    try {
    const installToken = await createTestToken(authPrivateKey, 'install-user', { scope: 'backups:write' });
    const started = await worker.fetch(new Request('https://keiko.example.test/v1/backups/github-installation', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${installToken}`,
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
      if (url === `${testAuthIssuer}/api/auth/jwks`) {
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
      expect(callback.headers.get('location')).toBe('https://matmetrics.example.test/?githubBackup=connected');
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
      expect(testEnv.BACKUP_QUEUE.send).toHaveBeenCalledWith(
        { kind: 'github-session-sync', userId: 'install-user' },
        { delaySeconds: 60 }
      );
      expect(await env.DB.prepare(
        `SELECT repository_id, generation, full_sync_required, wake_enqueued
         FROM github_session_sync_state WHERE user_id = ?`
      ).bind('install-user').first()).toMatchObject({
        repository_id: 88, generation: 1, full_sync_required: 1, wake_enqueued: 1,
      });
      const callCountAfterSuccess = githubCalls.length;
      const replay = await worker.fetch(new Request(callbackUrl), testEnv);
      expect(replay.headers.get('location')).toBe('https://matmetrics.example.test/?githubBackup=failed');
      expect(githubCalls).toHaveLength(callCountAfterSuccess);
    } finally {
      vi.stubGlobal('fetch', priorFetch);
      Reflect.set(appEnv, 'MATMETRICS_FRONTEND_URL', previousFrontendOrigin);
    }
  });

  it('accepts and consumes an OAuth state that is valid at consumption time', async () => {
    const priorFetch = globalThis.fetch;
    const previousFrontendOrigin = appEnv.MATMETRICS_FRONTEND_URL;
    const state = crypto.randomUUID() + crypto.randomUUID();
    const userId = `expiry-race-${crypto.randomUUID()}`;
    const stateHash = Array.from(new Uint8Array(await crypto.subtle.digest(
      'SHA-256', new TextEncoder().encode(state)
    ))).map((value) => value.toString(16).padStart(2, '0')).join('');
    const selectTime = '2026-10-18T10:00:00.000Z';
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
      .mockImplementationOnce(() => selectTime);

    try {
      const callbackUrl = new URL('/v1/backups/github-installation/callback', 'https://keiko.example.test');
      callbackUrl.searchParams.set('state', state);
      callbackUrl.searchParams.set('installation_id', '731');
      const callback = await worker.fetch(new Request(callbackUrl), appEnv);

      expect(callback.headers.get('location')).toBe('https://matmetrics.example.test/?githubBackup=connected');
      expect(await env.DB.prepare(
        'SELECT consumed_at FROM github_installation_states WHERE state_hash = ?'
      ).bind(stateHash).first()).toMatchObject({ consumed_at: selectTime });
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

  it('retries a Log Doctor write after a revision race when the source content is unchanged', async () => {
    const priorFetch = globalThis.fetch;
    const originalContent = '## Notes\n\nOriginal note\n';
    const writes: unknown[] = [];
    const installation = {
      user_id: 'log-doctor-retry-' + crypto.randomUUID(),
      installation_id: 731,
      repository_owner: 'maki',
      repository_name: 'judo-notes',
      repository_id: 88,
    };
    let putCount = 0;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith('/app/installations/731/access_tokens')) {
        return Response.json({ token: 'scoped-write-token' });
      }
      if (url.includes('/contents/data/') && init?.method === 'PUT') {
        writes.push(JSON.parse(String(init.body)));
        putCount += 1;
        if (putCount === 1) return Response.json({ message: 'validation failed' }, { status: 422 });
        return Response.json({ commit: { sha: 'saved-revision' } });
      }
      if (url.includes('/contents/data/') && (init?.method ?? 'GET') === 'GET') {
        return Response.json({
          sha: 'current-revision',
          encoding: 'base64',
          content: Buffer.from(originalContent).toString('base64'),
        });
      }
      throw new Error('Unexpected GitHub API request: ' + url);
    });

    try {
      const result = await updateSelectedGitHubMarkdown(
        appEnv,
        installation,
        'main',
        { path: 'data/2026/10/20261024-matmetrics-session-1.md', sha: 'stale-revision', content: originalContent },
        '## Notes\n\nCorrected note\n',
        originalContent
      );

      expect(result).toBe('saved-revision');
      expect(putCount).toBe(2);
      expect(writes[0]).toMatchObject({ sha: 'stale-revision' });
      expect(writes[1]).toMatchObject({ sha: 'current-revision' });
    } finally {
      vi.stubGlobal('fetch', priorFetch);
    }
  });

  it('does not retry a Log Doctor write when the source content has changed', async () => {
    const priorFetch = globalThis.fetch;
    const originalContent = '## Notes\n\nOriginal note\n';
    let putCount = 0;
    const installation = {
      user_id: 'log-doctor-conflict-' + crypto.randomUUID(),
      installation_id: 731,
      repository_owner: 'maki',
      repository_name: 'judo-notes',
      repository_id: 88,
    };
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith('/app/installations/731/access_tokens')) {
        return Response.json({ token: 'scoped-write-token' });
      }
      if (url.includes('/contents/data/') && init?.method === 'PUT') {
        putCount += 1;
        return Response.json({ message: 'validation failed' }, { status: 422 });
      }
      if (url.includes('/contents/data/') && (init?.method ?? 'GET') === 'GET') {
        return Response.json({
          sha: 'current-revision',
          encoding: 'base64',
          content: Buffer.from('## Notes\n\nConcurrent edit\n').toString('base64'),
        });
      }
      throw new Error('Unexpected GitHub API request: ' + url);
    });

    try {
      await expect(updateSelectedGitHubMarkdown(
        appEnv,
        installation,
        'main',
        { path: 'data/2026/10/20261024-matmetrics-session-1.md', sha: 'stale-revision', content: originalContent },
        '## Notes\n\nCorrected note\n',
        originalContent
      )).rejects.toThrow(/revision conflict/);
      expect(putCount).toBe(1);
    } finally {
      vi.stubGlobal('fetch', priorFetch);
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
    const sessions: GitHubSessionRow[] = [
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
    await syncGitHubSessionMarkdown(appEnv, { user_id: 'user-1', ...installation }, sessions);

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
      'keikoBackupVersion: 1',
      `keikoTextPayload: ${JSON.stringify(JSON.stringify({
        techniques: ['Uchi mata'],
        description: 'Entry practice',
        notes: 'private training note',
      }))}`,
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
    expect(uploadBody.message).toContain('Keiko Dojo backup session');
    expect(JSON.parse(String(uploads[1]?.init?.body))).toMatchObject({
      sha: 'existing-session-sha',
    });
    const secondMarkdown = Buffer.from(
      JSON.parse(String(uploads[1]?.init?.body)).content,
      'base64'
    ).toString('utf8');
    const expectedTextPayload = JSON.stringify({
      techniques: ['Randori drills\n# injected heading'],
      description: 'Warm-up\n---\n# Injected heading\n<script>alert(1)</script>',
      notes: '[link](https://evil.test)\n- injected list\n```html',
    });
    expect(secondMarkdown).toContain('keikoBackupVersion: 1');
    expect(secondMarkdown).toContain(
      `keikoTextPayload: ${JSON.stringify(expectedTextPayload)}`
    );
    expect(secondMarkdown).toContain('- Randori drills \\# injected heading');
    expect(secondMarkdown).toContain('Warm\\-up\n\\-\\-\\-\n\\# Injected heading\n&lt;script&gt;alert\\(1\\)&lt;/script&gt;');
    expect(secondMarkdown).toContain('\\[link\\]\\(https://evil\\.test\\)\n\\- injected list\n\\`\\`\\`html');
  });

  it.each([
    ['malformed JSON', '{invalid-json'],
    ['empty techniques', JSON.stringify({
      id: 'invalid-session',
      date: '2026-10-17',
      category: 'Technical',
      effort: 3,
      techniques: ['   '],
    })],
    ['credential-bearing video URL', JSON.stringify({
      id: 'invalid-session',
      date: '2026-10-17',
      category: 'Technical',
      effort: 3,
      techniques: ['Uchi mata'],
      videoUrl: credentialBearingVideoUrl(),
    })],
  ])('rejects stored sessions with %s before requesting GitHub access', async (_case, payload) => {
    const priorFetch = globalThis.fetch;
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      calls.push(url);
      throw new Error(`Unexpected GitHub API request: ${url}`);
    });
    const invalidSession: GitHubSessionRow = {
      id: 'invalid-session',
      session_date: '2026-10-17',
      category: 'Technical',
      effort: 3,
      payload,
      revision: 1,
      updated_at: '2026-10-17T00:00:00.000Z',
    };

    try {
      await expect(syncGitHubSessionMarkdown(
        appEnv,
        {
          user_id: 'user-1',
          installation_id: 731,
          repository_owner: 'maki',
          repository_name: 'judo-notes',
          repository_id: 88,
        },
        [invalidSession]
      )).rejects.toThrow('Stored session payload is invalid');
      expect(calls).toEqual([]);
      expect(errorLog).not.toHaveBeenCalled();
    } finally {
      errorLog.mockRestore();
      vi.stubGlobal('fetch', priorFetch);
    }
  });

  it('rejects GitHub Apps configured for all-repository installation access', async () => {
    const priorFetch = globalThis.fetch;
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      calls.push(url);
      if (url.endsWith('/app/installations/732')) {
        return Response.json({ id: 732, repository_selection: 'all' });
      }
      throw new Error(`Unexpected GitHub API request: ${url}`);
    });

    try {
      await expect(verifySelectedRepositoryInstallation(appEnv, 732))
        .rejects.toMatchObject({ phase: 'installation_scope' });
      expect(calls).toEqual(['https://api.github.com/app/installations/732']);
    } finally {
      vi.stubGlobal('fetch', priorFetch);
    }
  });

  it('rejects selected GitHub App installations that include multiple repositories', async () => {
    const priorFetch = globalThis.fetch;
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      calls.push(url);
      if (url.endsWith('/app/installations/733')) {
        return Response.json({ id: 733, repository_selection: 'selected' });
      }
      if (url.endsWith('/access_tokens')) return Response.json({ token: 'read-token' });
      if (url.includes('/installation/repositories')) {
        return Response.json({ total_count: 2, repositories: [{}, {}] });
      }
      throw new Error(`Unexpected GitHub API request: ${url}`);
    });

    try {
      await expect(verifySelectedRepositoryInstallation(appEnv, 733))
        .rejects.toMatchObject({ phase: 'repository_scope' });
      expect(calls).toEqual([
        'https://api.github.com/app/installations/733',
        'https://api.github.com/app/installations/733/access_tokens',
        'https://api.github.com/installation/repositories?per_page=100',
      ]);
    } finally {
      vi.stubGlobal('fetch', priorFetch);
    }
  });
