import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertProductionResources, parseJsonc } from './production-preflight.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function permissionError(resource, status, codes) {
  const codeText = codes.length ? ' Cloudflare code ' + codes.join(', ') + '.' : '';
  if (status === 403 || codes.includes(7403)) {
    if (resource === 'D1') {
      return new Error('Cloudflare denied the D1 read check.' + codeText + ' Verify D1 Read access and the account/resource scope.');
    }
    return new Error('Cloudflare denied the Worker read check.' + codeText + ' Verify Individual Workers Editor access scoped to keiko-dojo.');
  }
  if (status === 404) {
    return new Error('Cloudflare could not find the configured production ' + resource + ' resource. Check the account and resource configuration.');
  }
  return new Error('Cloudflare ' + resource + ' read check failed with HTTP ' + status + '.' + codeText);
}

async function request(path, resource, token, fetchImpl, { method = 'GET', body } = {}) {
  let response;
  try {
    response = await fetchImpl('https://api.cloudflare.com/client/v4' + path, {
      method,
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error('Cloudflare ' + resource + ' read check failed before receiving a response.');
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error('Cloudflare ' + resource + ' returned an unreadable response (HTTP ' + response.status + ').');
  }

  if (!response.ok || payload?.success === false) {
    const codes = (payload?.errors ?? []).map((error) => Number(error.code)).filter(Number.isFinite);
    throw permissionError(resource, response.status, codes);
  }
  return payload?.result;
}

export async function verifyCloudflareCredentials({ env, config, fetchImpl = fetch }) {
  if (!env.CLOUDFLARE_API_TOKEN) {
    throw new Error('Missing CLOUDFLARE_API_TOKEN in the protected cloudflare environment.');
  }
  if (!env.CLOUDFLARE_ACCOUNT_ID) {
    throw new Error('Missing CLOUDFLARE_ACCOUNT_ID in the protected cloudflare environment.');
  }
  if (!/^[a-f0-9]{32}$/i.test(env.CLOUDFLARE_ACCOUNT_ID)) {
    throw new Error('CLOUDFLARE_ACCOUNT_ID must be a 32-character hexadecimal account ID.');
  }
  const resources = assertProductionResources(config);
  const base = '/accounts/' + env.CLOUDFLARE_ACCOUNT_ID;
  const database = await request(
    base + '/d1/database/' + resources.databaseId,
    'D1',
    env.CLOUDFLARE_API_TOKEN,
    fetchImpl,
  );
  if (database?.uuid !== resources.databaseId || database?.name !== resources.databaseName) {
    throw new Error('The D1 resource returned by Cloudflare does not match the configured production database.');
  }

  const queryResult = await request(
    base + '/d1/database/' + resources.databaseId + '/query',
    'D1',
    env.CLOUDFLARE_API_TOKEN,
    fetchImpl,
    { method: 'POST', body: { sql: 'SELECT 1 AS credential_check' } },
  );
  const query = Array.isArray(queryResult) ? queryResult[0] : null;
  if (!query?.success || query.results?.[0]?.credential_check !== 1) {
    throw new Error('The read-only D1 query did not return the expected result.');
  }

  const workerResult = await request(
    base + '/workers/scripts/' + encodeURIComponent(resources.workerName) + '/deployments',
    'Worker',
    env.CLOUDFLARE_API_TOKEN,
    fetchImpl,
  );
  if (!Array.isArray(workerResult?.deployments) || workerResult.deployments.length === 0) {
    throw new Error('Cloudflare did not return a production deployment for the configured Worker.');
  }

  return {
    productionResourcesAccessible: true,
    databaseName: resources.databaseName,
    d1Read: 'passed',
    workerName: resources.workerName,
    workerRead: 'passed',
  };
}

async function main() {
  const config = parseJsonc(await readFile(resolve(ROOT, 'wrangler.jsonc'), 'utf8'));
  const result = await verifyCloudflareCredentials({ env: process.env, config });
  console.log('Read-only Cloudflare credential check passed: the configured account can access production D1 ' + result.databaseName + ' is readable; Worker ' + result.workerName + ' deployment metadata is readable.');
  console.log('This verifies the GitHub environment token and read access. It does not exercise D1 migration-write or Worker deployment-write permission.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : 'Unexpected Cloudflare credential preflight failure.';
    console.error('::error::' + message);
    process.exitCode = 1;
  });
}