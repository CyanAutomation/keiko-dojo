import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  assertIdempotencySchema,
  assertMigrationHistory,
  assertDeploymentMatchesRelease,
  assertProductionResources,
  assertQueueResources,
  assertWorkflowRevision,
  normalizeSql,
  parseJsonc,
  verifyProduction,
} from './production-preflight.mjs';
import { formatPreflightError } from './preflight-errors.mjs';

const config = {
  name: 'keiko-dojo-local',
  env: {
    production: {
      name: 'keiko-dojo',
      vars: { ENVIRONMENT: 'production' },
      d1_databases: [{
        binding: 'DB',
        database_name: 'keiko-dojo',
        database_id: '750315f8-ef51-4d6e-86ea-41b076ec9de8',
        migrations_dir: 'migrations',
      }],
      queues: {
        producers: [{ binding: 'BACKUP_QUEUE', queue: 'keiko-dojo-backups' }],
        consumers: [{ queue: 'keiko-dojo-backups', dead_letter_queue: 'keiko-dojo-backups-dlq' }],
      },
    },
  },
};

const migrations = [
  '0001_create_sessions.sql',
  '0002_create_backup_tables.sql',
  '0003_dedupe_scheduled_backups.sql',
  '0004_scheduled_backup_dispatch.sql',
  '0005_backup_snapshot_job_key.sql',
  '0006_github_operation_jobs.sql',
  '0007_github_session_sync.sql',
  '0008_session_create_idempotency.sql',
  '0009_future.sql',
];

test('parses JSONC comments and trailing commas without changing string values', () => {
  assert.deepEqual(parseJsonc(`{
    // config comment
    "url": "https://example.test/a//b",
    "list": [1, 2,],
  }`), {
    url: 'https://example.test/a//b',
    list: [1, 2],
  });
});

test('preserves comment markers and escaped quotes inside JSON strings', () => {
  assert.deepEqual(parseJsonc([
    '{',
    '  "url": "https://example.test/a//b",',
    '  "quoted": "A quote: \\" and markers: /* keep */",',
    '  /* multi-line',
    '     comment */',
    '  "items": [1, 2,],',
    '}',
  ].join('\n')), {
    url: 'https://example.test/a//b',
    quoted: 'A quote: " and markers: /* keep */',
    items: [1, 2],
  });
});

test('uses a safe fallback for non-Error preflight failures', () => {
  assert.equal(formatPreflightError(new Error('read failed'), 'fallback'), 'read failed');
  assert.equal(formatPreflightError({ secret: 'hidden' }, 'fallback'), 'fallback');
});

test('the checked-in production configuration selects the expected release resources', async () => {
  const actualConfig = parseJsonc(await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
  assert.deepEqual(assertProductionResources(actualConfig), {
    databaseId: '750315f8-ef51-4d6e-86ea-41b076ec9de8',
    databaseName: 'keiko-dojo',
    workerName: 'keiko-dojo',
    queueNames: ['keiko-dojo-backups', 'keiko-dojo-backups-dlq'],
  });
});

test('rejects a non-main dispatch or a checkout SHA that differs from the release SHA', () => {
  const sha = 'a'.repeat(40);
  assert.equal(assertWorkflowRevision({ ref: 'refs/heads/main', sha, checkoutSha: sha }), sha);
  assert.throws(() => assertWorkflowRevision({ ref: 'refs/heads/work', sha, checkoutSha: sha }), /refs\/heads\/main/);
  assert.throws(() => assertWorkflowRevision({ ref: 'refs/heads/main', sha, checkoutSha: 'b'.repeat(40) }), /checked-out commit/);
});

test('verifies the 100% deployed Worker version carries the reviewed release SHA', () => {
  const sha = 'a'.repeat(40);
  const deployments = [{
    versions: [{ version_id: 'version-id', percentage: 100 }],
    annotations: { 'workers/message': `keiko-release-sha:${sha}` },
  }];
  assert.deepEqual(assertDeploymentMatchesRelease(deployments, sha), {
    versionId: 'version-id',
    trafficPercentage: 100,
  });
  assert.throws(() => assertDeploymentMatchesRelease(deployments, 'b'.repeat(40)), /does not match/);
  assert.throws(() => assertDeploymentMatchesRelease([{ ...deployments[0], versions: [{ version_id: 'version-id', percentage: 50 }] }], sha), /100%/);
  assert.throws(() => assertDeploymentMatchesRelease([{ ...deployments[0], versions: [
    { version_id: 'version-one', percentage: 50 },
    { version_id: 'version-two', percentage: 50 },
  ] }], sha), /100%/);
});

test('accepts the configured production Worker and D1 resources', () => {
  assert.deepEqual(assertProductionResources(config), {
    databaseId: '750315f8-ef51-4d6e-86ea-41b076ec9de8',
    databaseName: 'keiko-dojo',
    workerName: 'keiko-dojo',
    queueNames: ['keiko-dojo-backups', 'keiko-dojo-backups-dlq'],
  });
});

test('rejects an unexpected production database binding', () => {
  const wrong = structuredClone(config);
  wrong.env.production.d1_databases[0].database_name = 'matmetrics-data';
  assert.throws(() => assertProductionResources(wrong), /Unexpected production D1/);
});

test('requires the production Keiko backup and dead-letter queues', () => {
  assert.doesNotThrow(() => assertQueueResources([
    { queue_name: 'keiko-dojo-backups' },
    { queue_name: 'keiko-dojo-backups-dlq' },
  ]));
  assert.throws(() => assertQueueResources([{ queue_name: 'keiko-dojo-backups' }]), /Missing production Queue resource/);
});

test('accepts an applied migration prefix with 0008 and allows later migrations to be pending', () => {
  assert.doesNotThrow(() => assertMigrationHistory(migrations, [
    '0001_create_sessions.sql',
    '0002_create_backup_tables.sql',
    '0003_dedupe_scheduled_backups.sql',
    '0004_scheduled_backup_dispatch.sql',
    '0005_backup_snapshot_job_key.sql',
    '0006_github_operation_jobs.sql',
    '0007_github_session_sync.sql',
    '0008_session_create_idempotency.sql',
  ], { requireAll: false }));
});

test('rejects missing 0008, gaps, unknown migrations, and post-migration pending files', () => {
  const appliedThroughEight = migrations.slice(0, 8);
  assert.throws(() => assertMigrationHistory(migrations, ['0001_create_sessions.sql'], { requireAll: false }), /0008/);
  assert.throws(() => assertMigrationHistory(migrations, appliedThroughEight, { requireAll: true }), /not applied/);
  assert.throws(() => assertMigrationHistory(migrations, [...appliedThroughEight.slice(0, 7), '0008_session_create_idempotency.sql', '0007_unknown.sql'], { requireAll: false }), /not present/);
  assert.throws(() => assertMigrationHistory(migrations, [...appliedThroughEight.slice(0, 6), '0008_session_create_idempotency.sql'], { requireAll: false }), /prefix/);
});

test('compares the D1 idempotency table schema independent of formatting', () => {
  const expected = 'CREATE TABLE session_create_idempotency (user_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, PRIMARY KEY (user_id, idempotency_key));';
  const actual = 'CREATE TABLE session_create_idempotency( user_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, PRIMARY KEY(user_id,idempotency_key) )';
  assert.equal(normalizeSql(expected), normalizeSql(actual));
  assert.doesNotThrow(() => assertIdempotencySchema(expected, actual));
  assert.throws(() => assertIdempotencySchema(expected, actual.replace('idempotency_key', 'other_key')), /does not match/);
});

test('verifies the configured D1, migration prefix, table schema, and active Worker through read-only requests', async () => {
  const migrationSql = 'CREATE TABLE session_create_idempotency (user_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, PRIMARY KEY (user_id, idempotency_key));';
  const calls = [];
  let deploymentVersions = [{ version_id: 'version-id', percentage: 100 }];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    let result;
    if (url.endsWith('/d1/database/750315f8-ef51-4d6e-86ea-41b076ec9de8')) {
      result = { uuid: '750315f8-ef51-4d6e-86ea-41b076ec9de8', name: 'keiko-dojo' };
    } else if (url.includes('/queues?')) {
      result = [
        { queue_name: 'keiko-dojo-backups' },
        { queue_name: 'keiko-dojo-backups-dlq' },
      ];
    } else if (url.endsWith('/workers/scripts/keiko-dojo/deployments')) {
      result = { deployments: [{ versions: deploymentVersions }] };
    } else {
      const sql = JSON.parse(options.body).sql;
      result = [{
        success: true,
        results: sql.includes('d1_migrations')
          ? migrations.slice(0, 8).map((name) => ({ name }))
          : [{ sql: migrationSql }],
      }];
    }
    return { ok: true, status: 200, json: async () => ({ success: true, result }) };
  };

  const preflightOptions = {
    env: { CLOUDFLARE_API_TOKEN: 'secret-token', CLOUDFLARE_ACCOUNT_ID: 'c'.repeat(32) },
    config,
    localNames: migrations,
    migrationSql,
    fetchImpl,
  };
  const verified = await verifyProduction(preflightOptions);
  assert.equal(verified.appliedMigrations, 8);
  assert.equal(verified.pendingMigrations, 1);
  assert.equal(calls.length, 5);
  assert.ok(calls.every(({ options }) => options.headers.Authorization === 'Bearer secret-token'));
  assert.deepEqual(calls.map(({ options }) => options.method ?? 'GET'), ['GET', 'GET', 'GET', 'POST', 'POST']);
  assert.ok(calls.slice(3).every(({ options }) => JSON.parse(options.body).sql.startsWith('SELECT')));

  deploymentVersions = [
    { version_id: 'version-one', percentage: 50 },
    { version_id: 'version-two', percentage: 50 },
  ];
  await assert.rejects(verifyProduction(preflightOptions), /100% traffic/);
});

test('reports D1 schema permission denial without returning Cloudflare response bodies', async () => {
  const migrationSql = 'CREATE TABLE session_create_idempotency (user_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, PRIMARY KEY (user_id, idempotency_key));';
  const fetchImpl = async (url, options) => {
    if (url.includes('/queues?')) {
      return { ok: true, status: 200, json: async () => ({ success: true, result: [
        { queue_name: 'keiko-dojo-backups' },
        { queue_name: 'keiko-dojo-backups-dlq' },
      ] }) };
    }
    if (url.endsWith('/d1/database/750315f8-ef51-4d6e-86ea-41b076ec9de8')) {
      return { ok: true, status: 200, json: async () => ({ success: true, result: {
        uuid: '750315f8-ef51-4d6e-86ea-41b076ec9de8',
        name: 'keiko-dojo',
      } }) };
    }
    if (url.endsWith('/workers/scripts/keiko-dojo/deployments')) {
      return { ok: true, status: 200, json: async () => ({ success: true, result: {
        deployments: [{ versions: [{ version_id: 'version-id', percentage: 100 }] }],
      } }) };
    }
    const sql = JSON.parse(options.body).sql;
    if (sql.includes('d1_migrations')) {
      return { ok: true, status: 200, json: async () => ({ success: true, result: [{
        success: true,
        results: migrations.slice(0, 8).map((name) => ({ name })),
      }] }) };
    }
    return {
      ok: false,
      status: 403,
      json: async () => ({ success: false, errors: [{ code: 7403, message: 'secret response body' }] }),
    };
  };
  await assert.rejects(
    verifyProduction({
      env: { CLOUDFLARE_API_TOKEN: 'secret-token', CLOUDFLARE_ACCOUNT_ID: 'c'.repeat(32) },
      config,
      localNames: migrations,
      migrationSql,
      fetchImpl,
    }),
    (error) => error.message.includes('D1 Edit') && error.message.includes('7403') && !error.message.includes('secret response body') && !error.message.includes('secret-token'),
  );
});
