# Keiko Dojo

[![CI](https://github.com/CyanAutomation/keiko-dojo/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/CyanAutomation/keiko-dojo/actions/workflows/ci.yml)

Keiko Dojo is the shared API and domain service for MatMetrics and related
training applications. It provides authenticated, user-scoped Judo session CRUD
on Cloudflare Workers and D1.

## Local development

Requirements: Node.js 26 and npm 11.6.2.

```bash
npm install --global npm@11.6.2
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
environment. As of 2026-11-18, Production D1 has migrations 0001 through 0008
and 39 sessions. The Worker is still on version
`a7c66220-8a1d-4326-b7e0-0366b87e68c3` from 2026-10-25, and the initial GitHub
Markdown reconciliation is incomplete. See
[`docs/operations.md`](docs/operations.md) for the observed state, diagnosis,
and recovery steps.

Deploy Production from `main` using the GitHub Actions **Deploy Production**
workflow. It runs the repository checks, applies Production migrations, then
deploys the Worker. Do not run the production deploy command from a local or
feature branch.

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

The GitHub Markdown API uses D1-backed dirty tracking and Cloudflare Queues.
After the initial repository sync, session creates, updates, and deletes are
coalesced for 60 seconds after the latest write, then synced to the selected
repository. GitHub failures never fail a successful D1 session write. The
repository is a second-brain Markdown copy, not a D1 snapshot or restore
source. A user can connect one GitHub App installation limited to one selected
repository. Configure its private key only as a Wrangler secret; Keiko creates
short-lived repository-scoped installation tokens. Keiko-backed GitHub health
checks, sync-all, and Log Doctor operations run as tenant-scoped queue jobs.
See [`docs/operations.md`](docs/operations.md) for the Production rollout.

Architecture decisions are recorded in [`docs/decisions/`](docs/decisions/).
