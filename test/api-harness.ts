import { env } from 'cloudflare:workers';
import type { JWK } from 'jose';
import { afterAll, beforeAll, vi } from 'vitest';
import worker from '../src/index';
import { createTrackedExecutionContext } from './execution-contexts';
import {
  createTestAuthKeys,
  createTestToken,
  testAuthAudience,
  testAuthIssuer,
  type TestTokenOptions,
} from './helpers';

const allowRateLimit = { limit: async (_input: { key: string }) => ({ success: true }) };

export function fetchWorker(request: Request, requestEnv: Env = env): Promise<Response> {
  return worker.fetch(request, requestEnv, createTrackedExecutionContext());
}

export function createApiHarness() {
  const issuer = testAuthIssuer;
  const jwksUrl = `${issuer}/api/auth/jwks`;
  const audience = testAuthAudience;
  const testEnv = Object.assign(Object.create(env), {
    SESSION_READ_LIMITER: allowRateLimit,
    SESSION_WRITE_LIMITER: allowRateLimit,
    BACKUP_WRITE_LIMITER: allowRateLimit,
  }) as Env;

  let privateKey: CryptoKey;
  let publicJwk: JWK;
  let originalFetch: typeof fetch;

  beforeAll(async () => {
    originalFetch = globalThis.fetch;
    const keys = await createTestAuthKeys();
    privateKey = keys.privateKey;
    publicJwk = keys.publicJwk;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.href === jwksUrl) return Response.json({ keys: [publicJwk] });
      if (url.href === `${issuer}/jwks-failure`) return new Response('not found', { status: 404 });
      if (url.href === `${issuer}/jwks-network-failure`) throw new TypeError('fetch failed');
      throw new Error(`Unexpected fetch: ${url.href}`);
    });
  });

  afterAll(() => {
    vi.stubGlobal('fetch', originalFetch);
  });

  async function tokenFor(userId: string, options: TestTokenOptions = {}): Promise<string> {
    return createTestToken(privateKey, userId, options);
  }

  async function call(
    path: string,
    userId: string,
    init: RequestInit = {},
    tokenOptions: TestTokenOptions = {},
    requestEnv: Env = testEnv
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${await tokenFor(userId, tokenOptions)}`);
    if (init.body !== undefined) headers.set('content-type', 'application/json');
    return fetchWorker(
      new Request(`https://keiko.example.test${path}`, {
        ...init,
        headers,
        body: init.body,
      }),
      requestEnv
    );
  }

  return { issuer, jwksUrl, audience, testEnv, tokenFor, call };
}
