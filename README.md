# Keiko Dojo

[![CI](https://github.com/CyanAutomation/keiko-dojo/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/CyanAutomation/keiko-dojo/actions/workflows/ci.yml)

Keiko Dojo is the shared API and domain service for MatMetrics and related
training applications. The first implementation provides authenticated,
user-scoped Judo session CRUD on Cloudflare Workers and D1.

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

Wrangler environments `staging` and `production` have separate Worker names
and D1 bindings. The single-account session cutover is complete: Production
contains all 38 sessions, its on-demand snapshot completed, and its Markdown
repository copy has exact payload parity. Staging and Production currently
contain matching 38-session datasets; Staging scheduled backups are disabled
and Production's first scheduled run is due at 02:00 UTC on 2026-10-26. The
current Production MatMetrics deployment points the allowlisted account at the
Production Keiko Worker. See [`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md)
for the pending GitHub-service deployment gate and Staging cleanup sequence.
Apply migrations to the corresponding remote database before routing clients
to that Worker:

```bash
npm run migrate:staging
npm run deploy:staging
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
repository-scoped installation tokens for backup writes. The local workspace
also implements queued GitHub health, sync-all, and Log Doctor operations for
the allowlisted MatMetrics account; these changes are not deployed yet. See
[`docs/operations.md`](docs/operations.md) for setup, recovery, and cutover.

Architecture decisions are recorded in [`docs/decisions/`](docs/decisions/).
