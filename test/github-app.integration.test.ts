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

  it('queues, processes, and reports a selected-repository health job', async () => {
    const priorFetch = globalThis.fetch;
    const userId = `health-job-${crypto.randomUUID()}`;
    const allowRateLimit = { limit: async (_input: { key: string }) => ({ success: true }) };
    const operationEnv = Object.assign(Object.create(appEnv), {
      SESSION_READ_LIMITER: allowRateLimit,
      SESSION_WRITE_LIMITER: allowRateLimit,
      BACKUP_WRITE_LIMITER: allowRateLimit,
    }) as Env;
    const installation = {
      user_id: userId, installation_id: 731,
      repository_owner: 'CyanAutomation', repository_name: 'matmetrics', repository_id: 88,
    };
    await env.DB.prepare(
      `INSERT INTO github_installations
       (user_id, installation_id, repository_owner, repository_name, repository_id, granted_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(userId, installation.installation_id, installation.repository_owner,
      installation.repository_name, installation.repository_id, new Date().toISOString()).run();
    const token = await createTestToken(authPrivateKey, userId, { scope: 'github:read' });
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === `${testAuthIssuer}/api/auth/jwks`) return Response.json({ keys: [authPublicJwk] });
      if (url.endsWith('/app/installations/731/access_tokens')) return Response.json({ token: 'installation-token' });
      if (url === 'https://api.github.com/repos/CyanAutomation/matmetrics') return Response.json({ default_branch: 'main' });
      if (url.endsWith('/git/ref/heads/main')) return Response.json({ object: { sha: 'b'.repeat(40) } });
      throw new Error(`Unexpected GitHub API request: ${url} (${init?.method ?? 'GET'})`);
    });

    try {
      const queued = await worker.fetch(new Request('https://keiko.example.test/v1/github/health', {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}',
      }), operationEnv);
      expect(queued.status).toBe(202);
      const job = await queued.json() as { id: string; type: string; status: string };
      const ack = vi.fn();
      const retry = vi.fn();
      await processGitHubOperationMessage({
        body: { kind: 'github-operation', jobId: job.id, userId },
        attempts: 1,
        ack,
        retry,
      } as unknown as Message<{ kind: 'github-operation'; jobId: string; userId: string }>, operationEnv);

      expect(job).toMatchObject({ type: 'github-health', status: 'queued' });
      expect(ack).toHaveBeenCalledOnce();
      expect(retry).not.toHaveBeenCalled();
      const status = await worker.fetch(new Request(`https://keiko.example.test/v1/github/jobs/${job.id}`, {
        headers: { authorization: `Bearer ${token}` },
      }), operationEnv);
      expect(status.status).toBe(200);
      expect(await status.json()).toMatchObject({
        id: job.id,
        type: 'github-health',
        status: 'completed',
        attempts: 1,
        result: { success: true, branch: 'main' },
      });
    } finally {
      await env.DB.prepare('DELETE FROM github_installations WHERE user_id = ?').bind(userId).run();
      await env.DB.prepare('DELETE FROM github_operation_jobs WHERE user_id = ?').bind(userId).run();
      vi.stubGlobal('fetch', priorFetch);
    }
  });

  it('checks and reads only the selected repository session Markdown with read permission', async () => {
    const priorFetch = globalThis.fetch;
    const requests: Array<{ url: string; body?: unknown; headers: Headers }> = [];
    const markdown = '---\nid: "session-1"\n---\n';
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      const body = init?.body ? JSON.parse(String(init.body)) as unknown : undefined;
      const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
      requests.push({ url, body, headers });
      if (url.endsWith('/app/installations/731/access_tokens')) {
        return Response.json({ token: 'read-token', expires_at: new Date(Date.now() + 60 * 60_000).toISOString() });
      }
      const etag = headers.get('if-none-match');
      if (etag) return new Response(null, { status: 304, headers: { etag, 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '4999' } });
      if (url === 'https://api.github.com/repos/CyanAutomation/matmetrics') {
        return Response.json({ default_branch: 'main' }, { headers: { etag: '"repo-main"', 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '4999' } });
      }
      if (url.endsWith('/git/ref/heads/main')) return Response.json({ object: { sha: 'a'.repeat(40) } }, { headers: { etag: '"ref-main"' } });
      if (url.endsWith('/git/trees/' + 'a'.repeat(40) + '?recursive=1')) {
        return Response.json({ truncated: false, tree: [
          { path: 'data/2026/10/20261024-matmetrics-session-1.md', type: 'blob', sha: 'blob-sha' },
          { path: 'other/readme.md', type: 'blob', sha: 'ignored' },
        ] }, { headers: { etag: '"tree-a"' } });
      }
      if (url.includes('/contents/data/2026/10/20261024-matmetrics-session-1.md?ref=main')) {
        return Response.json({ sha: 'blob-sha', encoding: 'base64', content: encodeBase64Utf8(markdown) }, { headers: { etag: '"blob-a"' } });
      }
      throw new Error(`Unexpected GitHub API request: ${url}`);
    });
    const installation = {
      user_id: 'user-a', installation_id: 731,
      repository_owner: 'CyanAutomation', repository_name: 'matmetrics', repository_id: 88,
    };

    try {
      const health = await checkSelectedGitHubRepository(appEnv, installation);
      const listing = await listSelectedGitHubSessionMarkdown(appEnv, installation);
      const repeatedListing = await listSelectedGitHubSessionMarkdown(appEnv, installation);

      expect(health).toMatchObject({ success: true, branch: 'main', rateLimit: { limit: 5000, remaining: 4999 } });
      expect(listing.branch).toBe('main');
      expect(listing.files).toEqual([{ path: 'data/2026/10/20261024-matmetrics-session-1.md', sha: 'blob-sha', content: markdown }]);
      expect(repeatedListing).toEqual(listing);
      expect(requests.filter((request) => String(request.url).endsWith('/app/installations/731/access_tokens')))
        .toHaveLength(1);
      expect(requests.filter((request) => String(request.url).endsWith('/app/installations/731/access_tokens'))
        .map((request) => request.body))
        .toEqual([{ repositories: ['matmetrics'], permissions: { contents: 'read' } }]);
      expect(requests.filter((request) => request.url.includes('/contents/data/')).map((request) => request.headers.get('if-none-match')))
        .toEqual([null, '"blob-a"']);
    } finally {
      vi.stubGlobal('fetch', priorFetch);
    }
  });

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
    const githubRequests: string[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === `${testAuthIssuer}/api/auth/jwks`) {
        return Response.json({ keys: [authPublicJwk] });
      }
      githubRequests.push(url);
      throw new Error(`Unexpected fetch: ${url}`);
    });

    try {
      const token = await createTestToken(authPrivateKey, userId, { scope: 'backups:write' });
      const response = await worker.fetch(new Request('https://keiko.example.test/v1/backups/github-installation', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: '{}',
      }), testEnv);

      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        error: { code: 'internal_error', message: 'GitHub App is not configured' },
      });
      expect(githubRequests).toEqual([]);
      const states = await env.DB.prepare(
        'SELECT state_hash FROM github_installation_states WHERE user_id = ?'
      ).bind(userId).all();
      expect(states.results).toHaveLength(0);
    } finally {
      vi.stubGlobal('fetch', priorFetch);
    }
  });

  // GitHub REST requires a User-Agent; a release-version change must not invalidate this check.
  it('includes the Keiko product identity in every GitHub API User-Agent', async () => {
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
      expect(requests.every(({ headers }) => /^Keiko-Dojo\/\S+$/.test(headers.get('user-agent') ?? ''))).toBe(true);
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
      }, { status: 403, headers: { 'x-github-request-id': 'GH-7f6e5d4c3b2a1' } });
    });

    try {
      await expect(syncGitHubSessionMarkdown(appEnv, {
        user_id: 'safe-backup-diagnostic',
        installation_id: 731,
        repository_owner: 'maki',
        repository_name: 'judo-notes',
        repository_id: 88,
      }, [{
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

      expect(errorLog).toHaveBeenCalledWith('github_session_sync_failed', {
        phase: 'session_contents',
        operation: 'contents_get',
        githubRequestId: 'GH-7f6e5d4c3b2a1',
        responseStatus: 403,
        causeName: 'GitHubAppApiError',
        causeCode: null,
        status: 403,
        reason: 'other',
        apiErrorCategory: 'forbidden',
        errorSummary: 'GitHub App API request failed',
      });
      expect(JSON.stringify(errorLog.mock.calls)).not.toContain('private provider detail');
    } finally {
      errorLog.mockRestore();
      vi.stubGlobal('fetch', priorFetch);
    }
  });

  it('logs transport diagnostics without exposing GitHub URLs, session paths, or query secrets', async () => {
    const priorFetch = globalThis.fetch;
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const privateUrl = 'https://api.github.com/repos/maki/judo-notes/contents/data/2026/10/20261024-matmetrics-safe-diagnostic-session.md?token=private-token-value';
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith('/app/installations/731/access_tokens')) {
        return Response.json({ token: 'write-install-token' });
      }
      expect(init?.method ?? 'GET').toBe('GET');
      throw new Error(
        `Failed to fetch ${privateUrl} for data/2026/10/20261024-matmetrics-safe-diagnostic-session.md with Bearer private-bearer-value`,
        { cause: Object.assign(new Error('socket failure'), { code: 'ECONNRESET' }) }
      );
    });

    try {
      await expect(syncGitHubSessionMarkdown(appEnv, {
        user_id: 'safe-transport-diagnostic',
        installation_id: 731,
        repository_owner: 'maki',
        repository_name: 'judo-notes',
        repository_id: 88,
      }, [{
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

      expect(errorLog).toHaveBeenCalledWith('github_session_sync_failed', expect.objectContaining({
        phase: 'session_contents',
        operation: 'contents_get',
        causeName: 'Error',
        causeCode: 'ECONNRESET',
        reason: 'network_error',
        errorSummary: 'Failed to fetch [url] for [session-path] with Bearer [redacted]',
      }));
      const logs = JSON.stringify(errorLog.mock.calls);
      expect(logs).not.toContain('api.github.com');
      expect(logs).not.toContain('safe-diagnostic-session');
      expect(logs).not.toContain('private-token-value');
      expect(logs).not.toContain('private-bearer-value');
    } finally {
      errorLog.mockRestore();
      vi.stubGlobal('fetch', priorFetch);
    }
  });

  it('redacts sensitive patterns that cross the error-summary truncation boundary', async () => {
    const priorFetch = globalThis.fetch;
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const prefix = `${Array.from({ length: 12 }, () => `ghp_${'a'.repeat(36)}`).join(' ')} ${'x'.repeat(18)}`;
    expect(prefix).toHaveLength(510);
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith('/app/installations/731/access_tokens')) {
        return Response.json({ token: 'write-install-token' });
      }
      throw new Error(`${prefix}https://private.example/secret?token=private-token`);
    });

    try {
      await expect(syncGitHubSessionMarkdown(appEnv, {
        user_id: 'boundary-redaction-diagnostic',
        installation_id: 731,
        repository_owner: 'maki',
        repository_name: 'judo-notes',
        repository_id: 88,
      }, [{
        id: 'boundary-redaction-session',
        session_date: '2026-10-24',
        category: 'Technical',
        effort: 3,
        payload: JSON.stringify({
          id: 'boundary-redaction-session', date: '2026-10-24', effort: 3,
          category: 'Technical', techniques: ['Uchi mata'],
        }),
        revision: 1,
        updated_at: '2026-10-24T00:00:00.000Z',
      }])).rejects.toThrow();

      const sanitizedPrefix = `${Array.from({ length: 12 }, () => '[token]').join(' ')} ${'x'.repeat(18)}`;
      expect(errorLog).toHaveBeenCalledWith('github_session_sync_failed', expect.objectContaining({
        errorSummary: `${sanitizedPrefix}[url]`,
      }));
      expect(JSON.stringify(errorLog.mock.calls)).not.toContain('private.example');
      expect(JSON.stringify(errorLog.mock.calls)).not.toContain('private-token');
    } finally {
      errorLog.mockRestore();
      vi.stubGlobal('fetch', priorFetch);
    }
  });

  it('records the GitHub request ID for a failed contents write without logging its response body', async () => {
    const priorFetch = globalThis.fetch;
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith('/app/installations/731/access_tokens')) {
        return Response.json({ token: 'write-install-token' });
      }
      if (init?.method === 'PUT') {
        return Response.json({ message: 'Validation Failed: private provider detail' }, {
          status: 422,
          headers: { 'x-github-request-id': 'GH-put-request-123' },
        });
      }
      return Response.json({ sha: 'current-file-sha', encoding: 'base64', content: encodeBase64Utf8('old content') }, {
        headers: { 'x-github-request-id': 'GH-get-request-123' },
      });
    });

    try {
      await expect(syncGitHubSessionMarkdown(appEnv, {
        user_id: 'safe-write-diagnostic',
        installation_id: 731,
        repository_owner: 'maki',
        repository_name: 'judo-notes',
        repository_id: 88,
      }, [{
        id: 'safe-write-session',
        session_date: '2026-10-24',
        category: 'Technical',
        effort: 3,
        payload: JSON.stringify({
          id: 'safe-write-session', date: '2026-10-24', effort: 3,
          category: 'Technical', techniques: ['Uchi mata'],
        }),
        revision: 1,
        updated_at: '2026-10-24T00:00:00.000Z',
      }])).rejects.toThrow();

      expect(errorLog).toHaveBeenCalledWith('github_session_sync_failed', expect.objectContaining({
        phase: 'session_contents',
        operation: 'contents_put',
        githubRequestId: 'GH-put-request-123',
        responseStatus: 422,
        causeName: 'GitHubAppApiError',
        apiErrorCategory: 'validation_failed',
        errorSummary: 'GitHub App API request failed',
      }));
      expect(JSON.stringify(errorLog.mock.calls)).not.toContain('private provider detail');
    } finally {
      errorLog.mockRestore();
      vi.stubGlobal('fetch', priorFetch);
    }
  });

  it('summarizes malformed GitHub JSON without logging a response snippet', async () => {
    const priorFetch = globalThis.fetch;
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith('/app/installations/731/access_tokens')) {
        return Response.json({ token: 'write-install-token' });
      }
      return new Response('private session payload must not appear', {
        status: 200,
        headers: { 'x-github-request-id': 'GH-invalid-json-123' },
      });
    });

    try {
      await expect(syncGitHubSessionMarkdown(appEnv, {
        user_id: 'safe-json-diagnostic',
        installation_id: 731,
        repository_owner: 'maki',
        repository_name: 'judo-notes',
        repository_id: 88,
      }, [{
        id: 'safe-json-session',
        session_date: '2026-10-24',
        category: 'Technical',
        effort: 3,
        payload: JSON.stringify({
          id: 'safe-json-session', date: '2026-10-24', effort: 3,
          category: 'Technical', techniques: ['Uchi mata'],
        }),
        revision: 1,
        updated_at: '2026-10-24T00:00:00.000Z',
      }])).rejects.toThrow();

      expect(errorLog).toHaveBeenCalledWith('github_session_sync_failed', expect.objectContaining({
        operation: 'contents_get',
        githubRequestId: 'GH-invalid-json-123',
        responseStatus: 200,
        causeName: 'SyntaxError',
        errorSummary: 'invalid_response_json',
      }));
      expect(JSON.stringify(errorLog.mock.calls)).not.toContain('private session payload');
    } finally {
      errorLog.mockRestore();
      vi.stubGlobal('fetch', priorFetch);
    }
  });
