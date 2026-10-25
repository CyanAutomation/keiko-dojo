# Keiko Dojo implementation and rollout plan

**Status (verified 2026-10-25):** The single-account production session cutover is complete. Staging and production health/readiness return HTTP 200, and all five D1 migrations are applied in both environments. Production contains all 38 source sessions; its complete analytics summary matches staging (38 sessions, average effort 3.63, and matching category/effort distributions). The live MatMetrics app writes to production only; authenticated create/read/delete returned 201/200/204 and a follow-up read returned 404. The deployed MatMetrics gateway correctly handles Keiko's bodyless 204 response. Production snapshot `6699dd39-4dee-4c4d-9ab9-6a7b45617b16` completed with 38 sessions, and the 38-file Markdown repository copy still has exact payload parity. The production GitHub App is installed only on `CyanAutomation/matmetrics`. Vercel Production points the existing allowlisted account at `https://keiko-dojo.scheimann.workers.dev`; deployment `dpl_Cv8Y96iTgUAuJZQcoBiADwrZBfqD` at commit `b7a53ce3919b7b21928860b61833866b4e52d2d5` owns `matmetrics-teal.vercel.app`. Staging scheduled backups are disabled and production's daily `0 2 * * *` schedule is enabled after the successful on-demand production snapshot. The prior D1 recovery rehearsal, restore safeguards, REST/MCP parity, scope denials, retry handling, and DLQ checks remain verified.

## Current implementation

Keiko owns a versioned session API backed by D1. The Worker validates EdDSA
tokens against Better Auth's configured JWKS, requires the exact
`keiko-dojo-api` audience and matching `sub` / `appUserId`, enforces scopes,
and rejects token lifetimes over five minutes. Session reads and writes are
tenant-scoped and writes use revision ETags. Analytics, paginated REST reads,
backup status/request/restore, and the read-only MCP tools share Keiko's
application service and D1 repository. Separate per-user rate-limit bindings
protect reads, session writes, and backup/restore operations in each deployed
environment. The production deployment has the first 38-session on-demand
snapshot; its first scheduled run is due at 02:00 UTC on 2026-10-26.

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

The workspace now also implements selected-repository GitHub health checks,
Log Doctor scans and guarded fixes, and on-demand sync-all as Keiko queue jobs.
Job reads are tenant-scoped. MatMetrics routes the allowlisted account's
existing GitHub controls through Keiko, polls job results, and provides a
selected GitHub App connect/disconnect panel. Other accounts retain the
existing MatMetrics GitHub path. These changes are local and tested; migration
0006 and the application changes have not been deployed.

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
- Scheduled backups now require the explicit `SCHEDULED_BACKUPS_ENABLED=true`
  flag. Local and production are enabled; staging is disabled after the
  production cutover so the two Workers cannot write the shared repository on
  overlapping schedules.
- Production JWKS configuration now matches the public MatMetrics JWKS proxy
  that was verified from the deployed staging Worker.
- Added `npm run backup:rehearse` to export remote D1 to a mode-0600 SQL file,
  restore it into an isolated local database, and report table counts without
  printing session data or Wrangler's temporary signed export URL. It requires
  an explicit `--confirm-export` flag because Wrangler warns that D1 may be
  unavailable while the export is running.
- Documented the Markdown-backed rollback check and D1 snapshot/restore
  rehearsal. The existing MatMetrics repository is the separate session-data
  backup; retaining an encrypted D1 SQL export outside Cloudflare is not a
  rollout requirement.
- Read-only MCP tools `list_sessions`, `get_session`, and
  `get_training_summary`, all requiring `sessions:read` and using the REST
  application service.
- MatMetrics server-side bearer-to-session binding, cookie allowlisting,
  CSRF checks, redirect rejection, upstream JWT verification, Keiko forwarding,
  and account allowlist routing through existing `/api/sessions*` routes.
- Local implementation of Keiko-backed GitHub health, sync-all, and Log Doctor
  jobs; selected-repository GitHub App settings in MatMetrics; and lossless
  Markdown normalization that retains Keiko's exact text payload. This work
  includes D1 migration 0006 and is not deployed yet.
- Dry-run-first Markdown importer and integration tests for the
  Vercel-to-Cloudflare cookie boundary.
- OpenAPI, auth decisions, setup guidance, and CI tests/type/migration checks.

## Remaining rollout work

1. **Observe the production schedule.** The first production snapshot was
   requested on demand and verified with 38 records. Confirm the first
   scheduled run completes before deploying migration 0006 or routing the
   remaining GitHub operations to Keiko. Continue monitoring sanitized Worker
   logs and backup status. Keep the allowlist limited to the existing user.
2. **Deploy and verify the GitHub service move.** Apply migration 0006 to
   production, deploy the Keiko Worker and MatMetrics Production code, then
   verify selected-repository connect/disconnect, health, 38-session sync,
   Log Doctor scan/preview/apply, tenant-scoped job polling, and retry/DLQ
   behavior. Training-plan insights and AI features remain in MatMetrics until
   their data-use policy is approved.
3. **Remove Staging after Production verification.** Once the new Production
   Worker and Vercel deployment pass those checks and a production backup job
   completes, remove the Staging Worker, D1 database, queues, dead-letter queue,
   rate-limit namespaces, GitHub App connection/secrets, and Staging Wrangler
   configuration and scripts. Retain the production and local environments.
4. **Onboard additional accounts separately.** Keep the current production
   allowlist scoped to the existing Better Auth user. Before adding another
   account, define its GitHub App installation and repository scope, repeat the
   import/backup/recovery checks, and verify tenant isolation with tests.

## Deployment boundaries

Keiko does not receive MatMetrics bearer tokens. The Auth Worker does not
receive the MatMetrics bearer token or client-controlled destinations. The
Keiko JWT is never returned to the browser. User IDs and repository names from
request bodies do not select D1 ownership. No AI provider receives Keiko
session data.

Production D1 and queues are deployed and contain the existing account's
38 sessions. MatMetrics Production routes only the allowlisted account to the
Keiko Production Worker. The Staging Worker remains available for recovery
comparison but its scheduled backup switch is off. Do not add more users,
deploy the remaining shared GitHub services, or remove Staging until the
scheduled production backup has completed and the single-account pilot remains
healthy.
