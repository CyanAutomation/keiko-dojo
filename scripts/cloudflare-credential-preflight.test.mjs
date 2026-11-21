import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { assertProductionResources, parseJsonc } from './production-preflight.mjs';
import { verifyCloudflareCredentials } from './cloudflare-credential-preflight.mjs';

const config = parseJsonc(await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
const resources = assertProductionResources(config);
const accountId = 'c'.repeat(32);
const databasePath = '/accounts/' + accountId + '/d1/database/' + resources.databaseId;
const queryPath = databasePath + '/query';
const workerPath = '/accounts/' + accountId + '/workers/scripts/' + resources.workerName + '/deployments';

function response(result, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => status >= 400
      ? { success: false, errors: [{ code: 7403, message: 'sensitive Cloudflare body' }] }
      : { success: true, result },
  };
}

function successfulFetch(calls) {
  return async (url, options) => {
    calls.push({ url: new URL(url), options });
    if (url.endsWith('/d1/database/' + resources.databaseId)) {
      return response({ uuid: resources.databaseId, name: resources.databaseName });
    }
    if (url.endsWith('/query')) {
      return response([{ success: true, results: [{ credential_check: 1 }] }]);
    }
    if (url.endsWith('/deployments')) {
      return response({ deployments: [{ id: 'production-deployment' }] });
    }
    throw new Error('Unexpected Cloudflare request: ' + url);
  };
}

test('checks the configured account, reads D1, and reads the configured Worker without writes', async () => {
  const calls = [];
  const result = await verifyCloudflareCredentials({
    env: { CLOUDFLARE_API_TOKEN: 'secret-token', CLOUDFLARE_ACCOUNT_ID: accountId },
    config,
    fetchImpl: successfulFetch(calls),
  });

  assert.deepEqual(result, {
    productionResourcesAccessible: true,
    databaseName: resources.databaseName,
    d1Read: 'passed',
    workerName: resources.workerName,
    workerRead: 'passed',
  });
  assert.deepEqual(calls.map(({ url, options }) => [url.pathname, options.method ?? 'GET']), [
    [databasePath, 'GET'],
    [queryPath, 'POST'],
    [workerPath, 'GET'],
  ]);
  assert.equal(JSON.parse(calls[1].options.body).sql, 'SELECT 1 AS credential_check');
  assert.ok(calls.every(({ options }) => options.headers.Authorization === 'Bearer secret-token'));
});

test('rejects missing credentials and malformed account IDs before making requests', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return response({}); };
  await assert.rejects(
    verifyCloudflareCredentials({ env: {}, config, fetchImpl }),
    /Missing CLOUDFLARE_API_TOKEN/,
  );
  await assert.rejects(
    verifyCloudflareCredentials({
      env: { CLOUDFLARE_API_TOKEN: 'secret-token', CLOUDFLARE_ACCOUNT_ID: 'not-an-account-id' },
      config,
      fetchImpl,
    }),
    /32-character hexadecimal account ID/,
  );
  assert.equal(calls, 0);
});

test('reports D1 access denial without logging the token or raw Cloudflare body', async () => {
  await assert.rejects(
    verifyCloudflareCredentials({
      env: { CLOUDFLARE_API_TOKEN: 'secret-token', CLOUDFLARE_ACCOUNT_ID: accountId },
      config,
      fetchImpl: async () => response(null, 403),
    }),
    (error) => {
    assert.match(error.message, /D1 Read/);
    assert.match(error.message, /7403/);
    assert.doesNotMatch(error.message, /secret-token|sensitive Cloudflare body/);
    return true;
  });
});

test('reports missing Worker deployment access with the scoped Worker permission', async () => {
  const calls = [];
  await assert.rejects(
    verifyCloudflareCredentials({
      env: { CLOUDFLARE_API_TOKEN: 'secret-token', CLOUDFLARE_ACCOUNT_ID: accountId },
      config,
      fetchImpl: async (url) => {
        calls.push(url);
        if (url.endsWith('/d1/database/' + resources.databaseId)) {
          return response({ uuid: resources.databaseId, name: resources.databaseName });
        }
        if (url.endsWith('/query')) {
          return response([{ success: true, results: [{ credential_check: 1 }] }]);
        }
        return response(null, 403);
      },
    }),
    (error) => {
    assert.match(error.message, /Individual Workers Editor/);
    assert.doesNotMatch(error.message, /secret-token|sensitive Cloudflare body/);
    return true;
  });
  assert.equal(calls.length, 3);
});