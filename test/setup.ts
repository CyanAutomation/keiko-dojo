import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { beforeEach } from 'vitest';

beforeEach(async () => {
  if (!env.TEST_MIGRATIONS?.length) {
    throw new Error('Keiko tests did not receive the D1 migrations');
  }
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await env.DB.prepare('DELETE FROM sessions').run();
});
