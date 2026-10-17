# Keiko Dojo implementation and rollout plan

**Status:** Code foundation implemented; staging validation and account-by-account cutover remain gated.

## Current implementation

Keiko owns a versioned session API backed by D1. The Worker validates EdDSA
tokens against Better Auth's configured JWKS, requires the exact
`keiko-dojo-api` audience and matching `sub` / `appUserId`, enforces scopes,
and rejects token lifetimes over five minutes. Session reads and writes are
tenant-scoped and writes use revision ETags. Analytics, paginated REST reads,
backup status/request/restore, and the read-only MCP tools share Keiko's
application service and D1 repository. Separate per-user rate-limit bindings
protect reads, session writes, and backup/restore operations in each deployed
environment.

MatMetrics retains its existing `matmetrics-api` bearer-token verifier and
browser auth workflow. For allowlisted accounts, its existing session routes
verify that bearer first, require an exact same-origin request, forward only
the Better Auth session cookie to the configured Auth Worker, and require the
Better Auth user ID to equal the verified bearer user before token issuance.
Vercel verifies the returned Keiko token and sends it only to Keiko. The
browser-facing `/api/auth/*` rewrite does not cover the internal issuance path.
There is no additional shared signing secret for Keiko tokens.

The Auth Worker uses Better Auth's existing JWKS-managed signer for the
Keiko-specific audience. Its regular `matmetrics-api` token route and
configuration remain unchanged. Cookie-authenticated issuance rejects
incorrect origins, cross-site requests, invalid sessions, mismatched users,
and unapproved scopes.

Keiko provides D1 snapshots, on-demand and scheduled queue jobs, a GitHub App
installation flow limited to one selected repository, one KeikoTracker-compatible
Markdown file per session under `data/YYYY/MM/`,
restore preview, explicit restore confirmation, restore activity records, and
merge behavior that preserves newer D1 records. The GitHub App private key is
the only additional long-lived credential required for GitHub App API access;
installation access tokens are short-lived, repository-scoped, and never
stored. GitHub sync failures do not block normal D1 session writes.

The MatMetrics importer is dry-run by default. It reports parse failures,
duplicate IDs, already-present records, payload mismatches, and importable
records. It imports only missing, unique records when invoked with `--apply`.
The server-side user allowlist is a separate setting, so an account is not
switched automatically by the importer.

## Implemented work

- Keiko Worker, D1 migrations, session CRUD, pagination, revisions, validation,
  tenant isolation, health, and readiness.
- Keiko-only auth scope enforcement, analytics summary, scoped backup APIs,
  Cloudflare Queue retries and dead-letter queue configuration, scheduled
  backups, restore safeguards, GitHub App selected-repository adapter, and
  per-session Markdown exports compatible with KeikoTracker.
- Read-only MCP tools `list_sessions`, `get_session`, and
  `get_training_summary`, all requiring `sessions:read` and using the REST
  application service.
- MatMetrics server-side bearer-to-session binding, cookie allowlisting,
  CSRF checks, redirect rejection, upstream JWT verification, Keiko forwarding,
  and account allowlist routing through existing `/api/sessions*` routes.
- Dry-run-first Markdown importer and integration tests for the
  Vercel-to-Cloudflare cookie boundary.
- OpenAPI, auth decisions, setup guidance, and CI tests/type/migration checks.

## Remaining rollout work

1. **Provision environments.** Create separate local, staging, and production
   D1 databases, backup queues, and dead-letter queues. Replace the placeholder
   IDs, Better Auth origins, MatMetrics staging origin, and GitHub App settings
   in `wrangler.jsonc`. Configure `GITHUB_APP_PRIVATE_KEY` with Wrangler
   secrets. The app must have Contents read/write permission and a configured
   callback at `/v1/backups/github-installation/callback`.
2. **Validate staging.** Apply migrations, deploy the staging Worker, test
   Better Auth/JWKS integration with two users, import and rollback, analytics
   parity, GitHub backup recovery, queue retries/DLQ, restore safeguards, and
   MCP/REST scope parity. Do not add production user IDs to the MatMetrics
   allowlist before this passes.
3. **Pilot accounts.** For each account, export current D1 before any rollback,
   run the importer dry-run, review mismatches and parse failures, apply only
   the reviewed missing records, compare the Keiko list with the Markdown
   source, then add the stable Better Auth user ID to
   `KEIKO_SESSION_CUTOVER_USER_IDS`. Keep the Markdown copy during the rollback
   window and avoid dual writes.
4. **Migrate remaining shared services.** Move the applicable GitHub sync,
   health, and Log Doctor operations behind Keiko's authenticated API and
   background jobs. Keep training-plan insights and AI features in MatMetrics
   until their data-use policy is approved.
5. **Production cutover.** Only after staging and recovery checks pass, create
   the production resources, apply reviewed migrations, deploy, enable a small
   pilot allowlist, monitor sanitized logs and metrics, and expand gradually.

## Deployment boundaries

Keiko does not receive MatMetrics bearer tokens. The Auth Worker does not
receive the MatMetrics bearer token or client-controlled destinations. The
Keiko JWT is never returned to the browser. User IDs and repository names from
request bodies do not select D1 ownership. No AI provider receives Keiko
session data.

Production remains off until the placeholders are replaced and staging
recovery has been demonstrated. No D1 resources or production deployments are
created by this repository change.
