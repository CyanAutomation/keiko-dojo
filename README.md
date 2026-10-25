# Keiko Dojo

[![CI](https://github.com/CyanAutomation/keiko-dojo/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/CyanAutomation/keiko-dojo/actions/workflows/ci.yml)

Keiko Dojo is the shared API and domain service for MatMetrics and related
training applications. It provides authenticated, user-scoped Judo session CRUD
on Cloudflare Workers and D1.

## Local development

Requirements: Node.js 24 and npm 11.

```bash
npm ci
npm run cf-typegen
npm run dev
```

Wrangler uses a local D1 database by default. Apply the schema with:

```bash
npm run migrate:local
```

The local Worker reads the public Better Auth JWKS URL, issuer, and Keiko
audience from `wrangler.jsonc`. It only accepts EdDSA tokens whose subject and
`appUserId` match, whose `scope` contains the required Keiko scope, and whose
issued lifetime is at most five minutes. MatMetrics retains its existing
`matmetrics-api` token and exchanges its Better Auth session cookie
server-to-server for a Keiko-only token for allowlisted accounts.

## Deployments

Wrangler keeps a local development configuration and a `production` remote
environment. The single-account Production cutover is complete: Production
contains all 38 sessions, its latest post-deployment D1 snapshot contains all
38, and the selected MatMetrics repository has a successful 38-session sync.
The Log Doctor scan checked all 38 training files successfully. MatMetrics
Production routes the allowlisted account to the Production Keiko Worker. See
[`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md) for current deployment and
environment-retirement status and [`docs/operations.md`](docs/operations.md)
for backup and recovery procedures.

Apply Production migrations before deploying a Worker change:

```bash
npm run migrate:production
npm run deploy:production
```

Do not use MatMetrics' `matmetrics-data` D1 database for Keiko Dojo. D1 session
queries use the Worker's binding API and parameterized statements; the D1
administrative REST API is not part of the runtime.

## API

The versioned REST contract is in [`openapi.yaml`](openapi.yaml). Every
session, analytics, backup, and MCP operation derives its account key from the
verified token. Client-supplied GitHub `owner` and `repo` values do not select
or authorize data. MCP is stateless at `/mcp` and exposes only
`list_sessions`, `get_session`, and `get_training_summary` with
`sessions:read`.

The backup API uses D1 snapshots and Cloudflare Queues. A user can connect one
GitHub App installation limited to one selected repository. Configure its
private key only as a Wrangler secret; Keiko creates short-lived
repository-scoped installation tokens for backup writes. Keiko-backed GitHub
health checks, sync-all, and Log Doctor operations run as tenant-scoped queue
jobs. See [`docs/operations.md`](docs/operations.md) for setup, recovery, and
rollback.

Architecture decisions are recorded in [`docs/decisions/`](docs/decisions/).
