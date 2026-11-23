import { env } from 'cloudflare:workers';
import { generateKeyPairSync } from 'node:crypto';
import type { JWK } from 'jose';
import { afterAll, beforeAll, vi } from 'vitest';
import { createTestAuthKeys } from './helpers';

const originalFetch = globalThis.fetch;

export type GitHubFetchRequest = {
  url: string;
  method: string;
  init?: RequestInit;
};

export type GitHubFetchRoute = {
  matches: (request: GitHubFetchRequest) => boolean;
  respond: (request: GitHubFetchRequest) => Response | Promise<Response>;
};

export let appEnv: Env & { GITHUB_APP_PRIVATE_KEY?: string };
export let authPrivateKey: CryptoKey;
export let authPublicJwk: JWK;

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
  const authKeys = await createTestAuthKeys();
  authPrivateKey = authKeys.privateKey;
  authPublicJwk = authKeys.publicJwk;
});

afterAll(() => {
  vi.stubGlobal('fetch', originalFetch);
});

export function encodeBase64Utf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function githubContentsPath(url: string): string {
  return decodeURIComponent(new URL(url).pathname.split('/contents/')[1] ?? '');
}

export function stubGitHubFetch(
  routes: GitHubFetchRoute[],
  beforeRequest?: (request: GitHubFetchRequest) => void
): void {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    const request = { url, method, init };
    beforeRequest?.(request);
    const route = routes.find((candidate) => candidate.matches(request));
    if (route) return route.respond(request);
    throw new Error(`Unexpected GitHub API request: ${url} (${method})`);
  });
}
