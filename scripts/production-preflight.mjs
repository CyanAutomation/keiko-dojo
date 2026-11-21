import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXPECTED = {
  workerName: 'keiko-dojo',
  databaseName: 'keiko-dojo',
  databaseId: '750315f8-ef51-4d6e-86ea-41b076ec9de8',
  binding: 'DB',
  idempotencyMigration: '0008_session_create_idempotency.sql',
};

export function parseJsonc(source) {
  let withoutComments = '';
  let quote = '';
  let escaped = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (quote) {
      withoutComments += character;
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = '';
      continue;
    }
    if (character === '"') {
      quote = character;
      withoutComments += character;
    } else if (character === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') index += 1;
      withoutComments += '\n';
    } else if (character === '/' && next === '*') {
      index += 2;
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) {
        if (source[index] === '\n') withoutComments += '\n';
        index += 1;
      }
      index += 1;
    } else {
      withoutComments += character;
    }
  }

  let json = '';
  quote = '';
  escaped = false;
  for (let index = 0; index < withoutComments.length; index += 1) {
    const character = withoutComments[index];
    if (quote) {
      json += character;
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = '';
      continue;
    }
    if (character === '"') {
      quote = character;
      json += character;
    } else if (character === ',') {
      let next = index + 1;
      while (/\s/.test(withoutComments[next] ?? '')) next += 1;
      if (withoutComments[next] !== '}' && withoutComments[next] !== ']') json += character;
    } else {
      json += character;
    }
  }
  return JSON.parse(json);
}

export function assertProductionResources(config) {
  const production = config?.env?.production;
  const databases = production?.d1_databases ?? [];
  const database = databases.find((item) => item.binding === EXPECTED.binding);
  if (production?.name !== EXPECTED.workerName || config.name === EXPECTED.workerName) {
    throw new Error('Unexpected production Worker name or environment selection.');
  }
  if (production?.vars?.ENVIRONMENT !== 'production') {
    throw new Error('Production Worker ENVIRONMENT is not production.');
  }
  if (databases.length !== 1 || database?.database_name !== EXPECTED.databaseName || database?.database_id !== EXPECTED.databaseId || database?.migrations_dir !== 'migrations') {
    throw new Error('Unexpected production D1 binding or database resource.');
  }
  const producer = production?.queues?.producers?.find((item) => item.binding === 'BACKUP_QUEUE');
  const consumer = production?.queues?.consumers?.find((item) => item.queue === 'keiko-dojo-backups');
  if (producer?.queue !== 'keiko-dojo-backups' || consumer?.dead_letter_queue !== 'keiko-dojo-backups-dlq') {
    throw new Error('Unexpected production Queue or dead-letter resource configuration.');
  }
  return {
    databaseId: database.database_id,
    databaseName: database.database_name,
    workerName: production.name,
    queueNames: ['keiko-dojo-backups', 'keiko-dojo-backups-dlq'],
  };
}

export function assertQueueResources(queues, expectedNames = ['keiko-dojo-backups', 'keiko-dojo-backups-dlq']) {
  const available = new Set((queues ?? []).map((queue) => queue.queue_name));
  const missing = expectedNames.filter((name) => !available.has(name));
  if (missing.length) throw new Error(`Missing production Queue resource${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}.`);
}

export function assertWorkflowRevision({ ref, sha, checkoutSha }) {
  if (ref !== 'refs/heads/main') throw new Error('Release revision mismatch: production deployment must use refs/heads/main.');
  if (!sha || !/^[a-f0-9]{40}$/i.test(sha) || sha.toLowerCase() !== checkoutSha.toLowerCase()) {
    throw new Error('Release revision mismatch: the checked-out commit does not match the dispatched GitHub revision.');
  }
  return sha.toLowerCase();
}

export function assertDeploymentMatchesRelease(deployments, sha) {
  const active = deployments?.[0];
  const versions = active?.versions ?? [];
  const trafficPercentage = versions.reduce((sum, version) => sum + version.percentage, 0);
  if (!active || !versions[0]?.version_id || trafficPercentage !== 100) {
    throw new Error('Unexpected Worker deployment state: production must have a version at 100% traffic.');
  }
  if (active.annotations?.['workers/message'] !== `keiko-release-sha:${sha}`) {
    throw new Error('Deployed Worker version does not match the reviewed release SHA.');
  }
  return { versionId: versions[0].version_id, trafficPercentage };
}

export function assertMigrationHistory(localNames, appliedNames, { requireAll = false } = {}) {
  const local = [...localNames].sort();
  const applied = [...appliedNames].sort();
  if (!local.includes(EXPECTED.idempotencyMigration) || !applied.includes(EXPECTED.idempotencyMigration)) {
    throw new Error(`Expected production migration ${EXPECTED.idempotencyMigration} is not recorded as applied.`);
  }
  if (applied.some((name) => !local.includes(name))) {
    throw new Error('Remote D1 migration history contains a migration not present in this release.');
  }
  if (applied.some((name, index) => local[index] !== name)) {
    throw new Error('Remote D1 migration history is not a prefix of the checked-in migrations.');
  }
  if (requireAll && applied.length !== local.length) {
    throw new Error('Production migration verification found local migrations that are not applied.');
  }
  return { applied: applied.length, pending: local.length - applied.length };
}

export function normalizeSql(sql) {
  return sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s*([(),])\s*/g, '$1')
    .replace(/;\s*$/, '')
    .trim()
    .toLowerCase();
}

export function assertIdempotencySchema(migrationSql, databaseSql) {
  if (!databaseSql || normalizeSql(migrationSql) !== normalizeSql(databaseSql)) {
    throw new Error('Production idempotency table schema does not match migration 0008.');
  }
}

function apiError(category, status, codes = []) {
  const code = codes.length ? ` Cloudflare code ${codes.join(', ')}.` : '';
  if (category.startsWith('D1') && (codes.includes(7403) || status === 403)) {
    return new Error(`D1 access denied.${code} Verify the account-scoped token includes D1 Edit and its account/resource scope includes the configured production D1 database.`);
  }
  if (category === 'Worker' && (status === 403 || codes.includes(7403))) {
    return new Error(`Worker deployment status is not accessible.${code} Verify the token includes Workers Scripts Edit and is scoped to the configured production account.`);
  }
  if (category === 'Queue' && (status === 403 || codes.includes(7403))) {
    return new Error(`Production Queue resources are not accessible.${code} Verify the token includes Workers Scripts Edit (or Queues Read) and is scoped to the configured production account.`);
  }
  if (status === 404) return new Error(`${category} production resource was not found. Verify the account ID and checked-in production resource configuration.`);
  return new Error(`${category} read-only preflight failed with HTTP ${status}.${code} Check Cloudflare account access, token permissions, and resource scope.`);
}

async function cloudflareRequest(path, token, fetchImpl) {
  const response = await fetchImpl(`https://api.cloudflare.com/client/v4${path}`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error(`Cloudflare returned an unreadable response (HTTP ${response.status}).`);
  }
  if (!response.ok || body.success === false) {
    const codes = (body.errors ?? []).map((error) => Number(error.code)).filter(Number.isFinite);
    throw { status: response.status, codes };
  }
  return body.result;
}

async function queryDatabase(accountId, databaseId, token, sql, fetchImpl) {
  const result = await cloudflareRequest(
    `/accounts/${accountId}/d1/database/${databaseId}/query`,
    token,
    (url, options) => fetchImpl(url, { ...options, method: 'POST', body: JSON.stringify({ sql }) }),
  );
  const query = Array.isArray(result) ? result[0] : null;
  if (!query?.success || !Array.isArray(query.results)) throw new Error('Remote D1 query did not return a successful result.');
  return query.results;
}

export async function verifyProduction({ env, config, localNames, migrationSql, fetchImpl = fetch, requireAll = false }) {
  if (!env.CLOUDFLARE_API_TOKEN) throw new Error('Missing API token: set CLOUDFLARE_API_TOKEN in the protected cloudflare environment.');
  if (!env.CLOUDFLARE_ACCOUNT_ID) throw new Error('Missing account variable: set CLOUDFLARE_ACCOUNT_ID in the protected cloudflare environment.');
  if (!/^[a-f0-9]{32}$/i.test(env.CLOUDFLARE_ACCOUNT_ID)) throw new Error('Invalid CLOUDFLARE_ACCOUNT_ID format.');
  const resources = assertProductionResources(config);
  const base = `/accounts/${env.CLOUDFLARE_ACCOUNT_ID}`;

  let queues;
  try {
    queues = await cloudflareRequest(`${base}/queues?per_page=500`, env.CLOUDFLARE_API_TOKEN, fetchImpl);
  } catch (error) {
    if (error?.status) throw apiError('Queue', error.status, error.codes);
    throw error;
  }
  assertQueueResources(queues, resources.queueNames);

  let database;
  try {
    database = await cloudflareRequest(`${base}/d1/database/${resources.databaseId}`, env.CLOUDFLARE_API_TOKEN, fetchImpl);
  } catch (error) {
    if (error?.status) throw apiError('D1', error.status, error.codes);
    throw error;
  }
  if (database.uuid !== resources.databaseId || database.name !== resources.databaseName) {
    throw new Error('Unexpected database binding: the Cloudflare D1 resource does not match the production configuration.');
  }

  let deployments;
  try {
    deployments = await cloudflareRequest(`${base}/workers/scripts/${resources.workerName}/deployments`, env.CLOUDFLARE_API_TOKEN, fetchImpl);
  } catch (error) {
    if (error?.status) throw apiError('Worker', error.status, error.codes);
    throw error;
  }
  const entries = deployments?.deployments ?? [];
  const active = entries[0];
  if (!active || !Array.isArray(active.versions) || active.versions.reduce((sum, version) => sum + version.percentage, 0) !== 100) {
    throw new Error('Unexpected Worker deployment state: the production Worker must have a readable deployment at 100% traffic.');
  }

  let appliedRows;
  try {
    appliedRows = await queryDatabase(env.CLOUDFLARE_ACCOUNT_ID, resources.databaseId, env.CLOUDFLARE_API_TOKEN, 'SELECT name FROM d1_migrations ORDER BY name', fetchImpl);
  } catch (error) {
    if (error?.status) throw apiError('D1 migration history', error.status, error.codes);
    throw new Error('Remote migration state unavailable. Verify D1 read access and that the production migration ledger exists.');
  }
  const appliedNames = appliedRows.map((row) => row.name);
  const migrationState = assertMigrationHistory(localNames, appliedNames, { requireAll });

  let schemaRows;
  try {
    schemaRows = await queryDatabase(env.CLOUDFLARE_ACCOUNT_ID, resources.databaseId, env.CLOUDFLARE_API_TOKEN, "SELECT sql FROM sqlite_master WHERE type='table' AND name='session_create_idempotency'", fetchImpl);
  } catch {
    throw new Error('Production idempotency schema could not be verified. Check D1 read access and migration 0008.');
  }
  assertIdempotencySchema(migrationSql, schemaRows[0]?.sql);
  return { ...resources, appliedMigrations: migrationState.applied, pendingMigrations: migrationState.pending, activeDeployment: active };
}

async function main() {
  const checkoutSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  const releaseSha = assertWorkflowRevision({
    ref: process.env.GITHUB_REF,
    sha: process.env.GITHUB_SHA,
    checkoutSha,
  });
  const config = parseJsonc(await readFile(resolve(ROOT, 'wrangler.jsonc'), 'utf8'));
  const migrationDirectory = resolve(ROOT, 'migrations');
  const localNames = (await readdir(migrationDirectory)).filter((name) => name.endsWith('.sql')).sort();
  const migrationSql = await readFile(resolve(migrationDirectory, EXPECTED.idempotencyMigration), 'utf8');
  const result = await verifyProduction({
    env: process.env,
    config,
    localNames,
    migrationSql,
    requireAll: process.argv.includes('--verify-migrations'),
  });
  if (process.argv.includes('--verify-deployment')) {
    const deployment = assertDeploymentMatchesRelease([result.activeDeployment], releaseSha);
    console.log(`Verified Worker version ${deployment.versionId} at ${deployment.trafficPercentage}% traffic for release ${releaseSha}.`);
  }
  console.log(`Release ${releaseSha} on main passed the read-only preflight for Worker ${result.workerName}, D1 ${result.databaseName} (${result.appliedMigrations} migrations applied, ${result.pendingMigrations} pending).`);
  console.log('Read access does not prove D1 migration-write or Worker script-edit permission; the migration and deploy steps remain the first write-capability checks.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : 'Unexpected preflight failure.';
    console.error(`::error::${message}`);
    process.exitCode = 1;
  });
}
