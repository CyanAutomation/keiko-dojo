---
name: cloudflare-operations
description: Maintain Keiko's Worker, D1, Queue, secret, migration, CI, and staged rollout configuration safely.
tags: [keiko-dojo, cloudflare-workers, d1, migrations, operations]
relatedSkills: [identity-and-tenant-security, github-markdown-sync]
---

# Cloudflare Operations

Use this skill when changing Wrangler bindings, Worker environments, D1
queries or migrations, queues, scheduled triggers, secrets, CI validation, or
deployment and recovery procedures.

## Read first

- `docs/operations.md` for current resource state, environment setup, rollout,
  recovery, and monitoring.
- `wrangler.jsonc` for actual Worker, D1, rate-limit, queue, and cron bindings.
- `.github/workflows/ci.yml` and `package.json` for the checks and commands
  currently enforced by CI.
- `docs/decisions/0001-runtime-and-data.md` for the Worker/D1 architecture.
- `src/storage/d1-session-repository.ts` for the current D1 access pattern;
  also read `identity-and-tenant-security` when changing tenant ownership.

## Environment boundaries

- Keep each configured environment's Worker, D1, Queue, DLQ, cron, and
  rate-limit namespace configuration separate. Check `docs/operations.md`
  before assuming staging resources exist. Do not point Keiko at MatMetrics'
  `matmetrics-data` database.
- Store `GITHUB_APP_PRIVATE_KEY` with Wrangler secrets; never put private keys
  or tokens in `wrangler.jsonc`, GitHub workflow variables, or source.
- Follow the validation and recovery gates currently documented in
  `docs/operations.md`. Check its current deployment state before assuming a
  migration, deployment, import, or cutover has happened.
- Apply a migration to the intended database before deploying code that
  depends on it. Add a new forward-only file under `migrations/`; never edit a
  migration already applied to a remote database.
- Use the Wrangler D1 binding for runtime access. The D1 administrative REST
  API is not part of the service runtime.
- Bind untrusted values in SQL. Scope every tenant-owned read and write by the
  verified user ID, including joins, upserts, and background work. Keep
  session persistence behavior aligned with `session-api-contract`.

## Commands and checks

The project targets Node.js 26 and npm 11.6.2. Local setup and routine checks use:

```bash
npm install --global npm@11.6.2
npm ci
npm run cf-typegen
npm run migrate:local
npm test
npm run cf-typegen:check
npm run typecheck
npm run check:migrations
```

`.github/workflows/ci.yml` is the definitive list of CI checks. It currently
runs the dependency audit, tests, generated Worker type checks, TypeScript type
checks, and local migration checks. Production deployment repeats these gates
in `.github/workflows/deploy-production.yml` before applying migrations and
deploying. Keep generated `worker-configuration.d.ts` in sync when bindings
change. Remote migration and deploy commands are environment-specific and
listed in `README.md`; follow the current rollout and recovery instructions in
`docs/operations.md` before using them.

When changing queues or scheduled jobs, update all environment bindings and
review retry, dead-letter, deduplication, and stale-dispatch recovery behavior
with `github-markdown-sync`.
