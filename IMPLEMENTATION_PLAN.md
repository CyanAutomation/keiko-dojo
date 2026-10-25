# Keiko Dojo implementation and rollout plan

**Status (verified 2026-10-25):** The single-account Production cutover and
GitHub-service move are complete. Migration 0006 and all earlier migrations
are applied in Production. Keiko Production health and readiness return HTTP
200. Production contains all 38 sessions; the latest post-deployment backup
completed at 20:28:49 UTC with a 38-session snapshot, and the selected
`CyanAutomation/matmetrics` repository contains all 38 synced session files.
The Production Log Doctor scan checked 38 files: 38 valid and 0 invalid.
MatMetrics Production routes the allowlisted account to
`https://keiko-dojo.scheimann.workers.dev` and serves
`matmetrics-teal.vercel.app`. The current Keiko Worker version is
`5e2edcc7-d2f4-4a35-a434-6a164f5d199a`; MatMetrics Production deployment
`dpl_DD42r7ZcwB6EVQ8pW2ARX8SFLY8r` is READY at commit
`9846c37c1697362f32174754bb53a0e8627c985c`. Staging Cloudflare resources were
retired after the Production verification and backup gates passed: the Worker,
D1 database, primary queue, and dead-letter queue are deleted, and Production
resources remain present. The Worker's GitHub private-key secret was removed
with it. The Staging GitHub App installation and its app registration are also
deleted. The Production GitHub App installation and registration remain active.

**Pre-rollout backup (2026-10-25 20:15 UTC):** A manually requested Production
backup job completed at 20:15:49 UTC with a 38-session snapshot and no error.
This satisfied the backup gate for migration 0006 and the GitHub service move.
Production's daily 02:00 UTC backup schedule remains enabled.

## Current implementation

Keiko owns a versioned session API backed by D1. The Worker validates EdDSA
tokens against Better Auth's configured JWKS, requires the exact
`keiko-dojo-api` audience and matching `sub` / `appUserId`, enforces scopes,
and rejects token lifetimes over five minutes. Session reads and writes are
tenant-scoped and writes use revision ETags. Analytics, paginated REST reads,
backup status/request/restore, and the read-only MCP tools share Keiko's
application service and D1 repository. Separate per-user rate-limit bindings
protect reads, session writes, and backup/restore operations in local and
Production.

MatMetrics retains its existing `matmetrics-api` bearer-token verifier and
browser auth workflow. For the allowlisted account, its session routes verify
that bearer first, require an exact same-origin request, forward only the
Better Auth session cookie to the configured Auth Worker, and require the Better
Auth user ID to equal the verified bearer user before token issuance. Vercel
verifies the returned Keiko token and sends it only to Keiko. The
browser-facing `/api/auth/*` rewrite does not cover the internal issuance path.
There is no additional shared signing secret for Keiko tokens.

Keiko provides D1 snapshots, on-demand and scheduled queue jobs, a GitHub App
installation flow limited to one selected repository, one KeikoTracker-
compatible Markdown file per session under `data/YYYY/MM/`, restore preview,
explicit restore confirmation, restore activity records, and merge behavior
that preserves newer D1 records. The GitHub App private key is the only
additional long-lived credential required for GitHub App API access;
installation access tokens are short-lived, repository-scoped, and never
stored. GitHub sync failures do not block normal D1 session writes.

Keiko-backed GitHub health checks, Log Doctor scans and guarded fixes, and
on-demand sync-all run as queue jobs. Job reads are tenant-scoped. MatMetrics
routes the allowlisted account's GitHub controls through Keiko, polls job
results, and provides a selected GitHub App connect/disconnect panel. Other
accounts retain the existing MatMetrics GitHub path. These features and
migration 0006 are deployed to Production. The Production health check and
38-session sync succeeded; Log Doctor reported 38 valid files and 0 invalid
files, so no fixes were needed.

The MatMetrics importer is dry-run by default. It reports parse failures,
duplicate IDs, already-present records, payload mismatches, Keiko-only records,
and importable records. It imports only missing, unique records when invoked
with `--apply`. The server-side user allowlist is a separate setting, so an
account is not switched automatically by the importer.

## Implemented work

- Keiko Worker, D1 migrations, session CRUD, pagination, revisions, validation,
  tenant isolation, health, and readiness.
- Keiko-only auth scope enforcement, analytics summary, scoped backup APIs,
  Cloudflare Queue retries and dead-letter queue configuration, scheduled
  backups, restore safeguards, GitHub App selected-repository adapter, and
  per-session Markdown exports compatible with KeikoTracker.
- Scheduled backups require the explicit `SCHEDULED_BACKUPS_ENABLED=true`
  flag. Local and Production are enabled; the Staging schedule was disabled
  before cutover.
- Production JWKS configuration matches the public MatMetrics JWKS proxy.
- `npm run backup:rehearse` exports remote D1 to a mode-0600 SQL file, restores
  it into an isolated local database, and reports table counts without
  printing session data or Wrangler's temporary signed export URL. It requires
  an explicit `--confirm-export` flag because Wrangler warns that D1 may be
  unavailable while the export is running.
- Read-only MCP tools `list_sessions`, `get_session`, and
  `get_training_summary`, all requiring `sessions:read` and using the REST
  application service.
- MatMetrics server-side bearer-to-session binding, cookie allowlisting, CSRF
  checks, redirect rejection, upstream JWT verification, Keiko forwarding,
  and account allowlist routing through existing `/api/sessions*` routes.
- Keiko-backed GitHub health, sync-all, and Log Doctor jobs; selected-repository
  GitHub App settings in MatMetrics; and lossless Markdown normalization that
  retains Keiko's exact text payload.
- Dry-run-first Markdown importer and integration tests for the
  Vercel-to-Cloudflare cookie boundary.
- OpenAPI, auth decisions, setup guidance, and CI tests/type/migration checks.

## Remaining rollout work

1. **Onboard additional accounts separately.** Keep the current Production
   allowlist scoped to the existing Better Auth user. Before adding another
   account, define its GitHub App installation and repository scope, repeat the
   import/backup/recovery checks, and verify tenant isolation with tests.

## Deployment boundaries

Keiko does not receive MatMetrics bearer tokens. The Auth Worker does not
receive the MatMetrics bearer token or client-controlled destinations. The
Keiko JWT is never returned to the browser. User IDs and repository names from
request bodies do not select D1 ownership. No AI provider receives Keiko
session data.

Production D1 contains the existing account's 38 sessions and the latest
completed snapshot contains all 38. MatMetrics Production routes only the
allowlisted account to the Keiko Production Worker. Keep the allowlist limited
to the current user. Local development remains available. The Staging Worker,
D1, queues, Wrangler environment, scripts, GitHub App installation, and app
registration have been retired.
