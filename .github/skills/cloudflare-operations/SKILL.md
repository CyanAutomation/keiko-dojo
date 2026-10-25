---
name: cloudflare-operations
description: Maintain Keiko's Worker, D1, Queue, secret, migration, CI, and staged rollout configuration safely.
tags: [keiko-dojo, cloudflare-workers, d1, migrations, operations]
relatedSkills: [identity-and-tenant-security, github-markdown-sync]
---

# Cloudflare Operations

Use this skill when changing Wrangler bindings, Worker environments, D1
migrations, queues, scheduled triggers, secrets, CI validation, or deployment
and recovery procedures.

## Read first

- `docs/operations.md` for current resource state, environment setup, rollout,
  recovery, and monitoring.
- `wrangler.jsonc` for actual Worker, D1, rate-limit, queue, and cron bindings.
- `.github/workflows/ci.yml` and `package.json` for the checks and commands
  currently enforced by CI.
- `docs/decisions/0001-runtime-and-data.md` for the Worker/D1 architecture.

## Environment boundaries

- Keep local, staging, and production Worker, D1, Queue, DLQ, cron, and
  rate-limit namespace configuration separate. Do not point Keiko at
  MatMetrics' `matmetrics-data` database.
- Store `GITHUB_APP_PRIVATE_KEY` with Wrangler secrets; never put private keys
  or tokens in `wrangler.jsonc`, GitHub workflow variables, or source.
- Keep production D1 and account cutover gated on staging and recovery
  validation. Check `docs/operations.md` for current deployment state before
  assuming a migration, deployment, import, or cutover has happened.
- Apply a migration to the intended database before deploying code that
  depends on it. Add a new forward-only file under `migrations/`; never edit a
  migration already applied to a remote database.
- Use the Wrangler D1 binding for runtime access. The D1 administrative REST
  API is not part of the service runtime.

## Commands and checks

The project targets Node.js 24 and npm 11. Local setup and routine checks use:

```bash
npm ci
npm run cf-typegen
npm run migrate:local
npm test
npm run cf-typegen:check
npm run typecheck
npm run check:migrations
```

CI runs tests, generated Worker type checks, TypeScript type checks, and local
migration checks. Keep generated `worker-configuration.d.ts` in sync when
bindings change. Remote migration and deploy commands are environment-specific
and listed in `README.md`; follow the staging and production gates in
`docs/operations.md` before using them.

When changing queues or scheduled jobs, update all environment bindings and
review retry, dead-letter, deduplication, and stale-dispatch recovery behavior
with `github-markdown-sync`.
