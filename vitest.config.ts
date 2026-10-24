import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      const { readD1Migrations } = await import('@cloudflare/vitest-plugin');
      return {
        wrangler: { configPath: path.join(root, 'wrangler.jsonc') },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: await readD1Migrations(
              path.join(root, 'migrations')
            ),
            AUTH_JWKS_URL: 'https://auth.example.test/api/auth/jwks',
            AUTH_ISSUER: 'https://auth.example.test',
            AUTH_AUDIENCE: 'keiko-dojo-api',
            ENVIRONMENT: 'test',
            SCHEDULED_BACKUPS_ENABLED: 'true',
          },
        },
      };
    }),
  ],
  test: {
    include: ['test/**/*.test.ts'],
    setupFiles: ['./test/setup.ts'],
  },
});
