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
  githubContentsPath,
  stubGitHubFetch,
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

  it('skips a GitHub content commit when the stored Markdown already matches', async () => {
    const priorFetch = globalThis.fetch;
    const requests: Array<{ method: string; url: string }> = [];
    const markdown = [
      '---',
      'id: "unchanged-session"',
      'date: "2026-10-24"',
      'effort: 3',
      'category: "Technical"',
      'keikoBackupVersion: 1',
      `keikoTextPayload: ${JSON.stringify(JSON.stringify({ techniques: ['Ōuchi mata'] }))}`,
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
      await syncGitHubSessionMarkdown(appEnv, {
        user_id: 'unchanged-backup-user',
        installation_id: 731,
        repository_owner: 'maki',
        repository_name: 'judo-notes',
        repository_id: 88,
      }, [{
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

  it('deletes a session Markdown file after the D1 session is deleted', async () => {
    const priorFetch = globalThis.fetch;
    const requests: Array<{ method: string; url: string; body?: unknown }> = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
      const body = init?.body ? JSON.parse(String(init.body)) as unknown : undefined;
      requests.push({ method, url, body });
      if (url.endsWith('/app/installations/731/access_tokens')) {
        return Response.json({ token: 'write-install-token' });
      }
      if (method === 'GET' && url.endsWith('/20261024-matmetrics-deleted-session.md')) {
        return Response.json({ sha: 'deleted-session-sha' });
      }
      if (method === 'DELETE' && url.endsWith('/20261024-matmetrics-deleted-session.md')) {
        return Response.json({ commit: { sha: 'delete-commit' } });
      }
      throw new Error(`Unexpected GitHub API request: ${url} (${method})`);
    });

    try {
      await syncGitHubSessionMarkdown(appEnv, {
        user_id: 'deleted-session-user', installation_id: 731,
        repository_owner: 'maki', repository_name: 'judo-notes', repository_id: 88,
      }, [], ['data/2026/10/20261024-matmetrics-deleted-session.md']);
      expect(requests.filter(({ method }) => method === 'DELETE')).toHaveLength(1);
      expect(requests.at(-1)?.body).toMatchObject({ sha: 'deleted-session-sha' });
    } finally {
      vi.stubGlobal('fetch', priorFetch);
    }
  });

  it('coalesces revisions and moves the managed Markdown path when a session date changes', async () => {
    const priorFetch = globalThis.fetch;
    const userId = `incremental-session-sync-${crypto.randomUUID()}`;
    const remoteFiles = new Map<string, string>();
    const writtenPaths: string[] = [];
    await env.DB.prepare(
      `INSERT INTO github_installations
       (user_id, installation_id, repository_owner, repository_name, repository_id, granted_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(userId, 902, 'maki', 'judo-notes', 902, new Date().toISOString()).run();
    const session = {
      id: 'moving-session', date: '2026-10-24', effort: 3, category: 'Technical',
      techniques: ['Uchi mata'], notes: 'initial',
    };
    const oldPath = 'data/2026/10/20261024-matmetrics-moving-session.md';
    const newPath = 'data/2026/11/20261101-matmetrics-moving-session.md';
    const readPath = (url: string) => decodeURIComponent(new URL(url).pathname.split('/contents/')[1] ?? '');
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
      if (url.endsWith('/app/installations/902/access_tokens')) {
        return Response.json({ token: 'incremental-sync-token' });
      }
      if (url.includes('/contents/')) {
        const path = readPath(url);
        if (method === 'GET') {
          const content = remoteFiles.get(path);
          return content === undefined
            ? new Response(null, { status: 404 })
            : Response.json({ sha: `sha-${path}`, encoding: 'base64', content: encodeBase64Utf8(content) });
        }
        if (method === 'PUT') {
          const payload = JSON.parse(String(init?.body)) as { content: string };
          remoteFiles.set(path, Buffer.from(payload.content, 'base64').toString('utf8'));
          writtenPaths.push(path);
          return Response.json({ content: { sha: `sha-${path}` } });
        }
        if (method === 'DELETE') {
          remoteFiles.delete(path);
          return Response.json({ commit: { sha: 'delete-commit' } });
        }
      }
      throw new Error(`Unexpected GitHub API request: ${url} (${method})`);
    });

    const runSync = async () => {
      const ack = vi.fn();
      const retry = vi.fn();
      await processGitHubSessionSyncMessage({
        body: { kind: 'github-session-sync', userId }, attempts: 1, ack, retry,
      } as unknown as Message<{ kind: 'github-session-sync'; userId: string }>, appEnv);
      expect(ack).toHaveBeenCalledOnce();
      expect(retry).not.toHaveBeenCalled();
    };

    try {
      await env.DB.prepare(
        `INSERT INTO sessions
         (user_id, id, session_date, category, effort, payload, revision, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`
      ).bind(userId, session.id, session.date, session.category, session.effort,
        JSON.stringify(session), new Date().toISOString(), new Date().toISOString()).run();
      const quickEdit = { ...session, notes: 'corrected quickly' };
      await env.DB.prepare(
        `UPDATE sessions SET payload = ?, revision = revision + 1, updated_at = ?
         WHERE user_id = ? AND id = ?`
      ).bind(JSON.stringify(quickEdit), new Date().toISOString(), userId, session.id).run();
      await env.DB.prepare(
        'UPDATE github_session_sync_state SET next_sync_at = ? WHERE user_id = ?'
      ).bind(new Date(0).toISOString(), userId).run();
      await runSync();
      expect(remoteFiles.has(oldPath)).toBe(true);
      expect(remoteFiles.get(oldPath)).toContain('corrected quickly');
      expect(writtenPaths).toEqual([oldPath]);

      const updated = { ...quickEdit, date: '2026-11-01', notes: 'latest edit' };
      await env.DB.prepare(
        `UPDATE sessions SET session_date = ?, payload = ?, revision = revision + 1, updated_at = ?
         WHERE user_id = ? AND id = ?`
      ).bind(updated.date, JSON.stringify(updated), new Date().toISOString(), userId, session.id).run();
      await env.DB.prepare(
        'UPDATE github_session_sync_state SET next_sync_at = ? WHERE user_id = ?'
      ).bind(new Date(0).toISOString(), userId).run();
      await runSync();

      expect(remoteFiles.has(oldPath)).toBe(false);
      expect(remoteFiles.get(newPath)).toContain('latest edit');
      expect(writtenPaths).toEqual([oldPath, newPath]);
      expect(await env.DB.prepare(
        'SELECT path, revision FROM github_synced_session_files WHERE user_id = ? AND repository_id = ? AND session_id = ?'
      ).bind(userId, 902, session.id).first()).toMatchObject({ path: newPath, revision: 3 });
      expect(await env.DB.prepare(
        'SELECT generation, completed_generation FROM github_session_sync_state WHERE user_id = ?'
      ).bind(userId).first()).toMatchObject({ generation: 3, completed_generation: 3 });
    } finally {
      vi.stubGlobal('fetch', priorFetch);
      await env.DB.batch([
        env.DB.prepare('DELETE FROM github_session_sync_state WHERE user_id = ?').bind(userId),
        env.DB.prepare('DELETE FROM github_synced_session_files WHERE user_id = ?').bind(userId),
        env.DB.prepare('UPDATE github_installations SET revoked_at = ? WHERE user_id = ?')
          .bind(new Date().toISOString(), userId),
        env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId),
      ]);
      await env.DB.prepare('DELETE FROM github_installations WHERE user_id = ?').bind(userId).run();
    }
  });

  it('initially reconciles current sessions and removes stale managed Markdown', async () => {
    const priorFetch = globalThis.fetch;
    const userId = `initial-session-sync-${crypto.randomUUID()}`;
    const currentPath = 'data/2026/10/20261025-matmetrics-current-session.md';
    const stalePath = 'data/2026/09/20260901-matmetrics-deleted-session.md';
    const requests: Array<{ method: string; url: string }> = [];
    await env.DB.prepare(
      `INSERT INTO github_installations
       (user_id, installation_id, repository_owner, repository_name, repository_id, granted_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(userId, 904, 'maki', 'judo-notes', 904, new Date().toISOString()).run();
    const session = {
      id: 'current-session', date: '2026-10-25', effort: 3, category: 'Technical',
      techniques: ['Uchi mata'], notes: 'latest notes',
    };
    const staleMarkdown = '---\nid: "deleted-session"\n---\n';
    stubGitHubFetch([
      {
        matches: ({ url }) => url.endsWith('/app/installations/904/access_tokens'),
        respond: ({ init }) => {
          const body = JSON.parse(String(init?.body)) as { permissions: { contents: string } };
          return Response.json({ token: body.permissions.contents === 'read' ? 'read-token' : 'write-token' });
        },
      },
      { matches: ({ url }) => url === 'https://api.github.com/repos/maki/judo-notes', respond: () => Response.json({ default_branch: 'main' }) },
      { matches: ({ url }) => url.endsWith('/git/ref/heads/main'), respond: () => Response.json({ object: { sha: 'a'.repeat(40) } }) },
      {
        matches: ({ url }) => url.endsWith('/git/trees/' + 'a'.repeat(40) + '?recursive=1'),
        respond: () => Response.json({ tree: [{ type: 'blob', path: stalePath, sha: 'stale-blob-sha' }] }),
      },
      {
        matches: ({ url, method }) => method === 'GET' && githubContentsPath(url) === stalePath,
        respond: () => Response.json({ sha: 'stale-file-sha', encoding: 'base64', content: encodeBase64Utf8(staleMarkdown) }),
      },
      {
        matches: ({ url, method }) => method === 'GET' && githubContentsPath(url) === currentPath,
        respond: () => new Response(null, { status: 404 }),
      },
      {
        matches: ({ url, method }) => method === 'PUT' && githubContentsPath(url) === currentPath,
        respond: () => Response.json({ content: { sha: 'current-file-sha' } }),
      },
      {
        matches: ({ url, method }) => method === 'DELETE' && githubContentsPath(url) === stalePath,
        respond: () => Response.json({ commit: { sha: 'delete-commit' } }),
      },
    ], ({ method, url }) => requests.push({ method, url }));

    try {
      await env.DB.prepare(
        `INSERT INTO sessions
         (user_id, id, session_date, category, effort, payload, revision, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`
      ).bind(userId, session.id, session.date, session.category, session.effort,
        JSON.stringify(session), new Date().toISOString(), new Date().toISOString()).run();
      await env.DB.prepare(
        `UPDATE github_session_sync_state SET full_sync_required = 1, next_sync_at = ?
         WHERE user_id = ?`
      ).bind(new Date(0).toISOString(), userId).run();

      const ack = vi.fn();
      const retry = vi.fn();
      await processGitHubSessionSyncMessage({
        body: { kind: 'github-session-sync', userId }, attempts: 1, ack, retry,
      } as unknown as Message<{ kind: 'github-session-sync'; userId: string }>, appEnv);

      expect(ack).toHaveBeenCalledOnce();
      expect(retry).not.toHaveBeenCalled();
      expect(requests.some(({ method, url }) => method === 'PUT' && url.endsWith('/' + currentPath))).toBe(true);
      expect(requests.some(({ method, url }) => method === 'DELETE' && url.endsWith('/' + stalePath))).toBe(true);
      expect(await env.DB.prepare(
        'SELECT session_id, path, revision FROM github_synced_session_files WHERE user_id = ? AND repository_id = ?'
      ).bind(userId, 904).all()).toMatchObject({ results: [{ session_id: session.id, path: currentPath, revision: 1 }] });
      expect(await env.DB.prepare(
        'SELECT full_sync_required, generation, completed_generation FROM github_session_sync_state WHERE user_id = ?'
      ).bind(userId).first()).toMatchObject({ full_sync_required: 0, generation: 1, completed_generation: 1 });
    } finally {
      vi.stubGlobal('fetch', priorFetch);
      await env.DB.batch([
        env.DB.prepare('DELETE FROM github_session_sync_state WHERE user_id = ?').bind(userId),
        env.DB.prepare('DELETE FROM github_synced_session_files WHERE user_id = ?').bind(userId),
        env.DB.prepare('UPDATE github_installations SET revoked_at = ? WHERE user_id = ?')
          .bind(new Date().toISOString(), userId),
        env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId),
      ]);
      await env.DB.prepare('DELETE FROM github_installations WHERE user_id = ?').bind(userId).run();
    }
  });

  it('splits a full sync across queue invocations to stay below the subrequest limit', async () => {
    const priorFetch = globalThis.fetch;
    const userId = `bounded-full-sync-${crypto.randomUUID()}`;
    const operationId = crypto.randomUUID();
    const now = new Date().toISOString();
    const remoteFiles = new Map<string, string>();
    const staleTreeEtag = '"bounded-full-sync-tree"';
    let conditionalTreeReads = 0;
    const syncFailures: unknown[][] = [];
    const syncFailureSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      syncFailures.push(args);
    });
    const continuations: Array<{ kind: 'github-session-sync'; userId: string; operationId?: string }> = [];
    const queueSend = vi.fn(async (message: unknown) => {
      continuations.push(message as { kind: 'github-session-sync'; userId: string; operationId?: string });
    });
    const syncEnv = Object.assign(Object.create(appEnv), {
      BACKUP_QUEUE: { send: queueSend },
    }) as Env;
    let requestsThisInvocation = 0;
    let maxRequestsInInvocation = 0;
    stubGitHubFetch([
      {
        matches: ({ url }) => url.endsWith('/app/installations/908/access_tokens'),
        respond: ({ init }) => {
          const body = JSON.parse(String(init?.body)) as { permissions: { contents: string } };
          return Response.json({
            token: body.permissions.contents === 'read' ? 'read-token' : 'write-token',
            expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
          });
        },
      },
      { matches: ({ url }) => url === 'https://api.github.com/repos/maki/judo-notes', respond: () => Response.json({ default_branch: 'main' }) },
      { matches: ({ url }) => url.endsWith('/git/ref/heads/main'), respond: () => Response.json({ object: { sha: 'd'.repeat(40) } }) },
      {
        matches: ({ url }) => url.endsWith('/git/trees/' + 'd'.repeat(40) + '?recursive=1'),
        respond: ({ init }) => {
          const requestHeaders = new Headers(init?.headers);
          if (requestHeaders.get('if-none-match') === staleTreeEtag) {
            conditionalTreeReads += 1;
            return new Response(null, { status: 304, headers: { etag: staleTreeEtag } });
          }
          return Response.json({
            truncated: false,
            tree: [...remoteFiles.keys()].map((path) => ({ type: 'blob', path, sha: `sha-${path}` })),
          }, { headers: { etag: staleTreeEtag } });
        },
      },
      {
        matches: ({ url, method }) => url.includes('/contents/') && method === 'GET',
        respond: ({ url }) => {
          const path = githubContentsPath(url);
          const content = remoteFiles.get(path);
          return content === undefined
            ? new Response(null, { status: 404 })
            : Response.json({ sha: `sha-${path}`, encoding: 'base64', content: encodeBase64Utf8(content) });
        },
      },
      {
        matches: ({ url, method }) => url.includes('/contents/') && method === 'PUT',
        respond: ({ url, init }) => {
          const path = githubContentsPath(url);
          const payload = JSON.parse(String(init?.body)) as { content: string };
          remoteFiles.set(path, Buffer.from(payload.content, 'base64').toString('utf8'));
          return Response.json({ content: { sha: `sha-${path}` } });
        },
      },
      {
        matches: ({ url, method }) => url.includes('/contents/') && method === 'DELETE',
        respond: ({ url }) => {
          remoteFiles.delete(githubContentsPath(url));
          return Response.json({ commit: { sha: 'delete-commit' } });
        },
      },
    ], () => {
      requestsThisInvocation += 1;
      maxRequestsInInvocation = Math.max(maxRequestsInInvocation, requestsThisInvocation);
      if (requestsThisInvocation > 50) throw new Error('Too many subrequests by single Worker invocation');
    });

    await env.DB.prepare(
      `INSERT INTO github_installations
       (user_id, installation_id, repository_owner, repository_name, repository_id, granted_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(userId, 908, 'maki', 'judo-notes', 908, now).run();
    await env.DB.prepare(
      `INSERT INTO github_operation_jobs
       (id, user_id, type, status, payload, created_at, updated_at)
       VALUES (?, ?, 'github-sync-all', 'queued', '{}', ?, ?)`
    ).bind(operationId, userId, now, now).run();
    const statements = Array.from({ length: 30 }, (_, index) => {
      const date = `2026-10-${String(index + 1).padStart(2, '0')}`;
      const session = {
        id: `bounded-session-${String(index).padStart(2, '0')}`,
        date,
        effort: 3,
        category: 'Technical',
        techniques: ['Uchi mata'],
      };
      return env.DB.prepare(
        `INSERT INTO sessions
         (user_id, id, session_date, category, effort, payload, revision, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`
      ).bind(userId, session.id, date, session.category, session.effort, JSON.stringify(session), now, now);
    });
    try {
      for (let offset = 0; offset < statements.length; offset += 10) {
        await env.DB.batch(statements.slice(offset, offset + 10));
      }
      for (let index = 0; index < 25; index += 1) {
        const date = `2025-01-${String(index + 1).padStart(2, '0')}`;
        const path = `data/2025/01/${date.replaceAll('-', '')}-matmetrics-stale-${String(index).padStart(2, '0')}.md`;
        remoteFiles.set(path, `stale file ${index}`);
      }
      const laterSessionPath = 'data/2026/10/20261001-matmetrics-bounded-session-00.md';
      await env.DB.prepare(
        `INSERT INTO github_synced_session_files
         (user_id, repository_id, session_id, path, revision) VALUES (?, ?, ?, ?, ?)`
      ).bind(userId, 908, 'bounded-session-00', laterSessionPath, 1).run();
      await env.DB.prepare(
        'UPDATE github_session_sync_state SET full_sync_required = 1, next_sync_at = ? WHERE user_id = ?'
      ).bind(new Date(0).toISOString(), userId).run();

      const pending: Array<{
        kind: 'github-session-sync';
        userId: string;
        operationId?: string;
      }> = [{ kind: 'github-session-sync', userId, operationId }];
      let invocations = 0;
      while (pending.length > 0 && invocations < 10) {
        const body = pending.shift()!;
        requestsThisInvocation = 0;
        const ack = vi.fn();
        const retry = vi.fn();
        await processGitHubSessionSyncMessage({ body, attempts: 1, ack, retry } as unknown as Message<{
          kind: 'github-session-sync'; userId: string; operationId?: string;
        }>, syncEnv);
        expect(ack, JSON.stringify(syncFailures)).toHaveBeenCalledOnce();
        expect(retry, JSON.stringify(syncFailures)).not.toHaveBeenCalled();
        pending.push(...continuations.splice(0));
        invocations += 1;
        if (invocations === 1) {
          expect(await env.DB.prepare(
            `SELECT path FROM github_synced_session_files
             WHERE user_id = ? AND repository_id = ? AND session_id = ?`
          ).bind(userId, 908, 'bounded-session-00').first()).toMatchObject({ path: laterSessionPath });
        }
      }

      expect(invocations).toBeGreaterThan(1);
      expect(pending).toHaveLength(0);
      expect(conditionalTreeReads).toBeGreaterThan(0);
      expect(maxRequestsInInvocation).toBeLessThanOrEqual(50);
      expect(remoteFiles.size).toBe(30);
      expect(await env.DB.prepare(
        'SELECT COUNT(*) AS count FROM github_synced_session_files WHERE user_id = ? AND repository_id = ?'
      ).bind(userId, 908).first()).toMatchObject({ count: 30 });
      expect(await env.DB.prepare(
        'SELECT full_sync_required, generation, completed_generation FROM github_session_sync_state WHERE user_id = ?'
      ).bind(userId).first()).toMatchObject({ full_sync_required: 0, generation: 30, completed_generation: 30 });
      const job = await env.DB.prepare(
        'SELECT status, result FROM github_operation_jobs WHERE id = ? AND user_id = ?'
      ).bind(operationId, userId).first<{ status: string; result: string | null }>();
      expect(job?.status).toBe('completed');
      expect(JSON.parse(job?.result ?? '{}')).toMatchObject({ success: true, sessionCount: 30 });
    } finally {
      vi.stubGlobal('fetch', priorFetch);
      syncFailureSpy.mockRestore();
      await env.DB.batch([
        env.DB.prepare('DELETE FROM github_operation_jobs WHERE id = ?').bind(operationId),
        env.DB.prepare('DELETE FROM github_session_sync_state WHERE user_id = ?').bind(userId),
        env.DB.prepare('DELETE FROM github_synced_session_files WHERE user_id = ?').bind(userId),
        env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId),
      ]);
      await env.DB.prepare('DELETE FROM github_installations WHERE user_id = ?').bind(userId).run();
    }
  });

  it('bounds an over-limit full sync and does not retry the permanent limit error', async () => {
    const priorFetch = globalThis.fetch;
    const userId = `session-sync-limit-${crypto.randomUUID()}`;
    const send = vi.fn(async (_message: unknown, _options?: unknown) => {});
    const syncEnv = Object.assign(Object.create(appEnv), {
      BACKUP_QUEUE: { send },
    }) as Env;
    const now = new Date().toISOString();
    const insert = (index: number) => {
      const session = {
        id: `over-limit-${index}`,
        date: '2026-10-25',
        techniques: ['Uchi mata'],
        effort: 3,
        category: 'Technical',
      };
      return env.DB.prepare(
        `INSERT INTO sessions
         (user_id, id, session_date, category, effort, payload, revision, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`
      ).bind(userId, session.id, session.date, session.category, session.effort,
        JSON.stringify(session), now, now);
    };
    const githubRequests: string[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      githubRequests.push(url);
      throw new Error(`Unexpected GitHub API request: ${url}`);
    });
    await env.DB.prepare(
      `INSERT INTO github_installations
       (user_id, installation_id, repository_owner, repository_name, repository_id, granted_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(userId, 905, 'maki', 'judo-notes', 905, now).run();

    try {
      const statements = Array.from({ length: 501 }, (_, index) => insert(index));
      for (let offset = 0; offset < statements.length; offset += 50) {
        await env.DB.batch(statements.slice(offset, offset + 50));
      }
      await env.DB.prepare(
        `UPDATE github_session_sync_state SET full_sync_required = 1, next_sync_at = ?
         WHERE user_id = ?`
      ).bind(new Date(0).toISOString(), userId).run();

      const ack = vi.fn();
      const retry = vi.fn();
      await processGitHubSessionSyncMessage({
        body: { kind: 'github-session-sync', userId }, attempts: 1, ack, retry,
      } as unknown as Message<{ kind: 'github-session-sync'; userId: string }>, syncEnv);

      expect(ack).toHaveBeenCalledOnce();
      expect(retry).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
      expect(githubRequests).toEqual([]);
      expect(await env.DB.prepare(
        'SELECT full_sync_required, last_error FROM github_session_sync_state WHERE user_id = ?'
      ).bind(userId).first()).toMatchObject({ full_sync_required: 1, last_error: 'session_limit_exceeded' });
      await dispatchPendingGitHubSessionSyncs(syncEnv);
      expect(send).not.toHaveBeenCalledWith(
        expect.objectContaining({ userId }),
        expect.anything()
      );
    } finally {
      vi.stubGlobal('fetch', priorFetch);
      await env.DB.batch([
        env.DB.prepare('DELETE FROM github_session_sync_state WHERE user_id = ?').bind(userId),
        env.DB.prepare('DELETE FROM github_synced_session_files WHERE user_id = ?').bind(userId),
        env.DB.prepare('UPDATE github_installations SET revoked_at = ? WHERE user_id = ?')
          .bind(new Date().toISOString(), userId),
        env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId),
      ]);
      await env.DB.prepare('DELETE FROM github_installations WHERE user_id = ?').bind(userId).run();
    }
  });

  it('acknowledges a terminal session-sync failure instead of retrying the message', async () => {
    const priorFetch = globalThis.fetch;
    const userId = `terminal-session-sync-${crypto.randomUUID()}`;
    const operationId = crypto.randomUUID();
    const now = new Date().toISOString();
    const queueSend = vi.fn(async (_message: unknown, _options?: unknown) => {});
    const syncEnv = Object.assign(Object.create(appEnv), {
      BACKUP_QUEUE: { send: queueSend },
    }) as Env;
    await env.DB.prepare(
      `INSERT INTO github_installations
       (user_id, installation_id, repository_owner, repository_name, repository_id, granted_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(userId, 906, 'CyanAutomation', 'judo-notes', 906, now).run();
    await env.DB.prepare(
      `INSERT INTO github_session_sync_state
       (user_id, repository_id, generation, full_sync_required, next_sync_at)
       VALUES (?, ?, 1, 1, ?)`
    ).bind(userId, 906, new Date(0).toISOString()).run();
    await env.DB.prepare(
      `INSERT INTO github_operation_jobs
       (id, user_id, type, status, payload, created_at, updated_at)
       VALUES (?, ?, 'github-sync-all', 'queued', '{}', ?, ?)`
    ).bind(operationId, userId, now, now).run();
    vi.stubGlobal('fetch', async () => { throw new Error('GitHub unavailable'); });
    const ack = vi.fn();
    const retry = vi.fn();

    try {
      await processGitHubSessionSyncMessage({
        body: { kind: 'github-session-sync', userId, operationId },
        attempts: 5,
        ack,
        retry,
      } as unknown as Message<{ kind: 'github-session-sync'; userId: string; operationId: string }>, syncEnv);

      expect(ack).toHaveBeenCalledOnce();
      expect(retry).not.toHaveBeenCalled();
      expect(await env.DB.prepare(
        'SELECT status, error_message FROM github_operation_jobs WHERE id = ?'
      ).bind(operationId).first()).toMatchObject({ status: 'failed', error_message: 'github_sync_failed' });
      expect(queueSend).not.toHaveBeenCalled();
    } finally {
      vi.stubGlobal('fetch', priorFetch);
      await env.DB.batch([
        env.DB.prepare('DELETE FROM github_operation_jobs WHERE id = ?').bind(operationId),
        env.DB.prepare('DELETE FROM github_session_sync_state WHERE user_id = ?').bind(userId),
        env.DB.prepare('DELETE FROM github_synced_session_files WHERE user_id = ?').bind(userId),
      ]);
      await env.DB.prepare('DELETE FROM github_installations WHERE user_id = ?').bind(userId).run();
    }
  });

  it('releases a failed sync lease and applies bounded retry delay before the terminal attempt', async () => {
    const priorFetch = globalThis.fetch;
    const userId = `retry-session-sync-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    const queueSend = vi.fn(async (_message: unknown, _options?: unknown) => {});
    const syncEnv = Object.assign(Object.create(appEnv), {
      BACKUP_QUEUE: { send: queueSend },
    }) as Env;
    await env.DB.prepare(
      `INSERT INTO github_installations
       (user_id, installation_id, repository_owner, repository_name, repository_id, granted_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(userId, 907, 'CyanAutomation', 'judo-notes', 907, now).run();
    await env.DB.prepare(
      `INSERT INTO github_session_sync_state
       (user_id, repository_id, generation, full_sync_required, next_sync_at)
       VALUES (?, ?, 1, 1, ?)`
    ).bind(userId, 907, new Date(0).toISOString()).run();
    vi.stubGlobal('fetch', async () => { throw new Error('GitHub unavailable'); });
    const ack = vi.fn();
    const retry = vi.fn();

    try {
      await processGitHubSessionSyncMessage({
        body: { kind: 'github-session-sync', userId },
        attempts: 2,
        ack,
        retry,
      } as unknown as Message<{ kind: 'github-session-sync'; userId: string }>, syncEnv);

      expect(ack).not.toHaveBeenCalled();
      expect(retry).toHaveBeenCalledWith({ delaySeconds: 20 });
      expect(queueSend).not.toHaveBeenCalled();
      expect(await env.DB.prepare(
        'SELECT lease_token, last_error FROM github_session_sync_state WHERE user_id = ?'
      ).bind(userId).first()).toMatchObject({ lease_token: null, last_error: 'github_sync_failed' });
    } finally {
      vi.stubGlobal('fetch', priorFetch);
      await env.DB.batch([
        env.DB.prepare('DELETE FROM github_session_sync_state WHERE user_id = ?').bind(userId),
        env.DB.prepare('DELETE FROM github_synced_session_files WHERE user_id = ?').bind(userId),
      ]);
      await env.DB.prepare('DELETE FROM github_installations WHERE user_id = ?').bind(userId).run();
    }
  });

  it('acknowledges a terminal GitHub operation failure instead of retrying the message', async () => {
    const userId = `terminal-operation-${crypto.randomUUID()}`;
    const jobId = crypto.randomUUID();
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO github_operation_jobs
       (id, user_id, type, status, payload, created_at, updated_at)
       VALUES (?, ?, 'github-health', 'queued', '{}', ?, ?)`
    ).bind(jobId, userId, now, now).run();
    const ack = vi.fn();
    const retry = vi.fn();

    try {
      await processGitHubOperationMessage({
        body: { kind: 'github-operation', jobId, userId },
        attempts: 5,
        ack,
        retry,
      } as unknown as Message<{ kind: 'github-operation'; jobId: string; userId: string }>, appEnv);

      expect(ack).toHaveBeenCalledOnce();
      expect(retry).not.toHaveBeenCalled();
      expect(await env.DB.prepare(
        'SELECT status FROM github_operation_jobs WHERE id = ?'
      ).bind(jobId).first()).toMatchObject({ status: 'failed' });
    } finally {
      await env.DB.prepare('DELETE FROM github_operation_jobs WHERE id = ?').bind(jobId).run();
    }
  });
