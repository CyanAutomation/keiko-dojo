import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { reportPreflightFailure } from './preflight-errors.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXPECTED = {
  workerName: 'keiko-dojo',
  databaseName: 'keiko-dojo',
  databaseId: '750315f8-ef51-4d6e-86ea-41b076ec9de8',
  binding: 'DB',
  idempotencyMigration: '0008_session_create_idempotency.sql',
};

function copyJsonStringCharacter(character, state) {
  if (state.escaped) state.escaped = false;
  else if (character === '\\') state.escaped = true;
  else if (character === '"') state.inString = false;
  return character;
}

function lineCommentEnd(source, start) {
  const newline = source.indexOf('\n', start + 2);
  return newline < 0 ? source.length : newline;
}

function blockComment(source, start) {
  const close = source.indexOf('*/', start + 2);
  const end = close < 0 ? source.length : close + 2;
  return {
    text: source.slice(start, end).replace(/[^\n]/g, ''),
    nextIndex: end,
  };
}

function transformJsoncOutsideString(source, index, operation) {
  const character = source[index];
  if (operation === 'comments' && character === '/' && source[index + 1] === '/') {
    return { text: '', nextIndex: lineCommentEnd(source, index) - 1 };
  }
  if (operation === 'comments' && character === '/' && source[index + 1] === '*') {
    const comment = blockComment(source, index);
    return { text: comment.text, nextIndex: comment.nextIndex - 1 };
  }
  if (operation === 'trailing_commas' && character === ',' && isTrailingComma(source, index)) {
    return { text: '', nextIndex: index };
  }
  return { text: character, nextIndex: index };
}

function transformJsonc(source, operation) {
  let output = '';
  const state = { inString: false, escaped: false };
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (state.inString) {
      output += copyJsonStringCharacter(character, state);
      continue;
    }
    if (character === '"') {
      state.inString = true;
      output += character;
      continue;
    }
    const transformed = transformJsoncOutsideString(source, index, operation);
    output += transformed.text;
    index = transformed.nextIndex;
  }
  return output;
}

function nextNonWhitespaceIndex(source, start) {
  let index = start;
  while (/\s/.test(source[index] ?? '')) index += 1;
  return index;
}

function isTrailingComma(source, index) {
  const next = source[nextNonWhitespaceIndex(source, index + 1)];
  return next === '}' || next === ']';
}

export function parseJsonc(source) {
  const withoutComments = transformJsonc(source, 'comments');
  return JSON.parse(transformJsonc(withoutComments, 'trailing_commas'));
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

function requireSingleFullTrafficVersion(active, message) {
  const versions = active?.versions;
  if (!active || !Array.isArray(versions) || versions.length !== 1 || !versions[0]?.version_id || versions[0].percentage !== 100) {
    throw new Error(message);
  }
  return versions[0];
}

export function assertDeploymentMatchesRelease(deployments, sha) {
  const active = deployments?.[0];
  const version = requireSingleFullTrafficVersion(active, 'Unexpected Worker deployment state: production must have a version at 100% traffic.');
  if (active.annotations?.['workers/message'] !== `keiko-release-sha:${sha}`) {
    throw new Error('Deployed Worker version does not match the reviewed release SHA.');
  }
  return { versionId: version.version_id, trafficPercentage: version.percentage };
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
  const guidance = {
    D1: ['D1 access denied.', ' Verify the account-scoped token includes D1 Edit and its account/resource scope includes the configured production D1 database.'],
    Worker: ['Worker deployment status is not accessible.', ' Verify the token includes Workers Scripts Edit and is scoped to the configured production account.'],
    Queue: ['Production Queue resources are not accessible.', ' Verify the token includes Workers Scripts Edit (or Queues Read) and is scoped to the configured production account.'],
  };
  const service = category.startsWith('D1') ? 'D1' : category;
  if (guidance[service] && (status === 403 || codes.includes(7403))) {
    return new Error(guidance[service][0] + code + guidance[service][1]);
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

async function readCloudflareResource(category, path, token, fetchImpl) {
  try {
    return await cloudflareRequest(path, token, fetchImpl);
  } catch (error) {
    if (error?.status) throw apiError(category, error.status, error.codes);
    throw error;
  }
}

async function readProductionDatabaseRows({ accountId, databaseId, token, sql, category, failureMessage, fetchImpl }) {
  try {
    return await queryDatabase(accountId, databaseId, token, sql, fetchImpl);
  } catch (error) {
    if (error?.status) throw apiError(category, error.status, error.codes);
    throw new Error(failureMessage);
  }
}

function requireProductionDatabase(database, resources) {
  if (database.uuid !== resources.databaseId || database.name !== resources.databaseName) {
    throw new Error('Unexpected database binding: the Cloudflare D1 resource does not match the production configuration.');
  }
}

function requireProductionDeployment(deployments) {
  const active = deployments?.deployments?.[0];
  requireSingleFullTrafficVersion(active, 'Unexpected Worker deployment state: the production Worker must have a readable deployment at 100% traffic.');
  return active;
}

export async function verifyProduction({ env, config, localNames, migrationSql, fetchImpl = fetch, requireAll = false }) {
  if (!env.CLOUDFLARE_API_TOKEN) throw new Error('Missing API token: set CLOUDFLARE_API_TOKEN in the protected cloudflare environment.');
  if (!env.CLOUDFLARE_ACCOUNT_ID) throw new Error('Missing account variable: set CLOUDFLARE_ACCOUNT_ID in the protected cloudflare environment.');
  if (!/^[a-f0-9]{32}$/i.test(env.CLOUDFLARE_ACCOUNT_ID)) throw new Error('Invalid CLOUDFLARE_ACCOUNT_ID format.');
  const resources = assertProductionResources(config);
  const base = `/accounts/${env.CLOUDFLARE_ACCOUNT_ID}`;

  const queues = await readCloudflareResource(
    'Queue', `${base}/queues?per_page=500`, env.CLOUDFLARE_API_TOKEN, fetchImpl
  );
  assertQueueResources(queues, resources.queueNames);

  const database = await readCloudflareResource(
    'D1', `${base}/d1/database/${resources.databaseId}`, env.CLOUDFLARE_API_TOKEN, fetchImpl
  );
  requireProductionDatabase(database, resources);

  const deployments = await readCloudflareResource(
    'Worker', `${base}/workers/scripts/${resources.workerName}/deployments`, env.CLOUDFLARE_API_TOKEN, fetchImpl
  );
  const active = requireProductionDeployment(deployments);

  const appliedRows = await readProductionDatabaseRows({
    accountId: env.CLOUDFLARE_ACCOUNT_ID,
    databaseId: resources.databaseId,
    token: env.CLOUDFLARE_API_TOKEN,
    sql: 'SELECT name FROM d1_migrations ORDER BY name',
    category: 'D1 migration history',
    failureMessage: 'Remote migration state unavailable. Verify D1 read access and that the production migration ledger exists.',
    fetchImpl,
  });
  const appliedNames = appliedRows.map((row) => row.name);
  const migrationState = assertMigrationHistory(localNames, appliedNames, { requireAll });

  const schemaRows = await readProductionDatabaseRows({
    accountId: env.CLOUDFLARE_ACCOUNT_ID,
    databaseId: resources.databaseId,
    token: env.CLOUDFLARE_API_TOKEN,
    sql: "SELECT sql FROM sqlite_master WHERE type='table' AND name='session_create_idempotency'",
    category: 'D1 schema',
    failureMessage: 'Production idempotency schema could not be verified. Check D1 read access and migration 0008.',
    fetchImpl,
  });
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
  main().catch((error) => reportPreflightFailure(error, 'Unexpected preflight failure.'));
}
