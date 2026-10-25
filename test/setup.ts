import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { beforeEach } from 'vitest';

beforeEach(async () => {
  if (!env.TEST_MIGRATIONS?.length) {
    throw new Error('Keiko tests did not receive the D1 migrations');
  }
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM github_session_sync_state'),
    env.DB.prepare('DELETE FROM github_synced_session_files'),
    env.DB.prepare('DELETE FROM github_operation_jobs'),
    env.DB.prepare('DELETE FROM github_installation_states'),
    env.DB.prepare('DELETE FROM github_installations'),
    env.DB.prepare('DELETE FROM sessions'),
  ]);
});
