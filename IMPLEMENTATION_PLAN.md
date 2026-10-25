# Keiko Dojo implementation and rollout plan

**Verified Production state (2026-10-25):** The single-account Production
cutover and GitHub-service move are complete. Production contains all 38
sessions; `CyanAutomation/matmetrics` contains all 38 session Markdown files,
and the Production Log Doctor scan found 38 valid files and 0 invalid files.
MatMetrics Production routes the allowlisted account to
`https://keiko-dojo.scheimann.workers.dev` and serves
`matmetrics-teal.vercel.app`. The deployed Worker version at that verification
was `5e2edcc7-d2f4-4a35-a434-6a164f5d199a`; MatMetrics Production deployment
`dpl_DD42r7ZcwB6EVQ8pW2ARX8SFLY8r` was READY at commit
`9846c37c1697362f32174754bb53a0e8627c985c`.

The deferred GitHub Markdown sync and D1 snapshot removal described in this
change are local and have not been applied to Production. Migration 0007 drops
the retired D1 snapshot tables and requests a full reconciliation for existing
GitHub connections. Applying it removes the stored application snapshot rows;
it leaves the selected repository's Markdown intact.

Staging Cloudflare resources were retired after Production verification: the
Worker, D1 database, primary queue, and dead-letter queue were deleted. The
Staging GitHub App installation and registration were also deleted. Production
resources and its GitHub App installation remain active.

## Current implementation

Keiko owns a versioned session API backed by D1. The Worker validates EdDSA
tokens against Better Auth's configured JWKS, requires the exact
`keiko-dojo-api` audience and matching `sub` / `appUserId`, enforces scopes,
and rejects token lifetimes over five minutes. Session reads and writes are
tenant-scoped and writes use revision ETags. Analytics, REST reads, and the
read-only MCP tools share Keiko's application service and D1 repository.

MatMetrics retains its existing `matmetrics-api` bearer-token verifier and
browser auth workflow. For the allowlisted account, its session routes verify
that bearer first, require an exact same-origin request, forward only the
Better Auth session cookie to the configured Auth Worker, and require the
Better Auth user ID to equal the verified bearer user before token issuance.
Vercel verifies the returned Keiko token and sends it only to Keiko. The
browser-facing `/api/auth/*` rewrite does not cover the internal issuance path.
There is no additional shared signing secret for Keiko tokens.

The selected GitHub repository is a second-brain Markdown copy, not a D1
snapshot or restore source. After the initial full reconciliation, D1 triggers
persist dirty session IDs transactionally with session creates, updates, and
deletes. A delayed Cloudflare Queue message syncs the latest session state 60
seconds after the most recent write. GitHub errors do not fail D1 writes;
durable dirty state, queue retries, and a one-minute cron recover missed or
failed work. A date change moves the Markdown file, and a delete removes its
managed file. Explicit full sync also removes stale managed session Markdown.

One GitHub App installation is limited to one selected repository. The App
private key is stored only as a Wrangler secret; installation access tokens are
short-lived, repository-scoped, and never stored. Keiko-backed GitHub health
checks, Log Doctor scans and guarded fixes, and sync-all run as tenant-scoped
queue jobs.

The MatMetrics importer remains dry-run by default for the separate application
storage cutover. It is not a way to restore Markdown into Keiko D1.

## Implemented work

- Keiko Worker, D1 migrations, session CRUD, pagination, revisions, validation,
  tenant isolation, health, and readiness.
- Keiko-only auth scope enforcement, analytics summary, and per-user request
  limits.
- Read-only MCP tools `list_sessions`, `get_session`, and
  `get_training_summary`, all requiring `sessions:read` and using the REST
  application service.
- MatMetrics server-side bearer-to-session binding, cookie allowlisting, CSRF
  checks, redirect rejection, upstream JWT verification, Keiko forwarding, and
  account allowlist routing through existing `/api/sessions*` routes.
- GitHub App selected-repository integration, tenant-scoped GitHub health,
  sync-all and Log Doctor jobs, and the MatMetrics GitHub settings panel.
- D1-backed deferred Markdown sync, delayed coalescing, initial and explicit
  reconciliation, safe retries, and deletion/path-move handling.
- Migration 0007 to remove D1 application snapshot tables and schedule initial
  reconciliation for existing GitHub connections.
- OpenAPI, session contract, operations guidance, repository skills, and
  integration coverage for automatic sync and removed snapshot APIs.

## Remaining rollout work

1. Apply migration 0007 to Production, then deploy the Worker with its
   one-minute cron and delayed queue processing.
2. Confirm the migration removed the old application snapshot tables, the
   initial reconciliation completed, all 38 Markdown files remain current,
   and subsequent session create/update/delete operations converge after the
   60-second debounce.
3. Keep the Production account allowlist scoped to the existing Better Auth
   user. Onboard additional accounts separately after defining their GitHub
   repository scope and repeating tenant-isolation checks.

## Deployment boundaries

Keiko does not receive MatMetrics bearer tokens. The Auth Worker does not
receive the MatMetrics bearer token or client-controlled destinations. The
Keiko JWT is never returned to the browser. User IDs and repository names from
request bodies do not select D1 ownership. No AI provider receives Keiko
session data.

Keep MatMetrics' `matmetrics-data` database separate from Keiko D1. The GitHub
repository remains available for MatMetrics' Markdown-backed application
storage route and second-brain use; it is not a Keiko D1 restore source.
