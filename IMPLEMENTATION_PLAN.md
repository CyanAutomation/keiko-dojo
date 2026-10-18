# Keiko Dojo implementation and rollout plan

**Status:** Code foundation and isolated Cloudflare staging/production resources are provisioned. The staging Worker is deployed and health-checked; end-to-end account validation and the single-account cutover remain gated.

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

1. **Provision environments.** Use the local D1 emulator. The separate staging
   and production D1 databases, backup queues, and dead-letter queues are
   provisioned. The D1 IDs and verified existing Better Auth JWKS/issuer are
   configured in `wrangler.jsonc`. Production D1 remains empty and unmigrated.
   Do not use Vercel Preview deployments for this rollout. No separate
   MatMetrics staging origin is needed for the one-account pilot: keep the
   current production origin and route only that user's session API calls to
   staging through MatMetrics' server-side cutover allowlist. After the staging
   import is reviewed, set the Vercel production variables to the staging Keiko
   URL, the exact current frontend origin, and only the existing account's ID;
   redeploy MatMetrics Production so the values take effect.
   The current Vercel project has no custom-environment capacity, which does
   not block this approach. Set `GITHUB_APP_PRIVATE_KEY` with Wrangler
   secrets. The app must have Contents read/write permission and a configured
   callback at `/v1/backups/github-installation/callback`.
2. **Validate staging.** Apply migrations, deploy the staging Worker, and
   validate the Auth Worker/JWKS path with the sole existing MatMetrics
   account. Use synthetic identities in Keiko's automated integration tests
   for cross-tenant isolation; do not require or create a second live account.
   Also verify import and rollback, analytics parity, GitHub backup recovery,
   queue retries/DLQ, restore safeguards, and MCP/REST scope parity. Do not add
   the production user ID to Keiko production before this passes.
3. **Pilot the existing account in staging.** From the MatMetrics repository,
   export the account's current data, run the importer dry-run against staging,
   review mismatches and parse failures, apply only reviewed missing records,
   and compare Keiko's complete session list and analytics with the Markdown
   source. Exercise rollback in staging. Keep the Markdown copy and avoid dual
   writes. The Vercel Production cutover allowlist may include this ID only
   while its `KEIKO_API_BASE_URL` points to staging; do not route the user to
   Keiko production until staging and recovery checks pass.
4. **Production cutover.** Only after staging and recovery checks pass, apply
   reviewed migrations to the already-provisioned production D1 and deploy.
   Export the existing account's current data, dry-run and review the import,
   apply only reviewed missing records, compare full session and analytics
   parity, then switch the Vercel Production `KEIKO_API_BASE_URL` to the
   production Worker for that one already-allowlisted Better Auth user ID.
   Monitor sanitized logs and metrics and keep the rollout at this account
   until more accounts are onboarded.
5. **Migrate remaining shared services.** After the single-account production
   session cutover is stable, move applicable GitHub sync, health, and Log
   Doctor operations behind Keiko's authenticated API and background jobs.
   Keep training-plan insights and AI features in MatMetrics until their
   data-use policy is approved.

## Deployment boundaries

Keiko does not receive MatMetrics bearer tokens. The Auth Worker does not
receive the MatMetrics bearer token or client-controlled destinations. The
Keiko JWT is never returned to the browser. User IDs and repository names from
request bodies do not select D1 ownership. No AI provider receives Keiko
session data.

Production remains off until staging recovery has been demonstrated. The
production D1 and queues are provisioned but remain empty; no production Worker
deployment, schema migration, session import, or account cutover has occurred.
