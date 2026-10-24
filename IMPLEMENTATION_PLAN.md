# Keiko Dojo implementation and rollout plan

**Status (verified 2026-10-24):** The isolated Cloudflare staging/production resources are provisioned. Staging health/readiness return HTTP 200 and all five D1 migrations are applied. Staging contains 37 imported sessions; the complete list and analytics match the MatMetrics source (zero missing IDs or payload mismatches). A queued D1 snapshot completed and a previewed, explicitly confirmed restore of all 37 sessions succeeded with analytics unchanged. REST/MCP analytics parity and read/write scope denials were verified. The staging GitHub App is installed only on `CyanAutomation/matmetrics` and its private key is configured, but Keiko's installation callback receives HTTP 403 from GitHub, so GitHub repository sync/recovery remains unverified. The configured backup queue and DLQ are present; successful queue delivery and terminal retry handling are verified, but a live poison-message DLQ handoff was not exercised. Production D1 has no Keiko application tables, and no production Worker is deployed.

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

1. **Finalize staging pilot configuration.** The separate staging and
   production D1 databases, backup queues, and dead-letter queues are
   provisioned. The staging D1 IDs and verified existing Better Auth
   JWKS/issuer are configured in `wrangler.jsonc`; migrations `0001` through
   `0005` are applied and staging contains the imported 37-session account.
   The three staging rate-limit namespace IDs are deployed and unique across the current account
   Worker scripts. The `Keiko Dojo Staging` GitHub App is registered for the
   CyanAutomation account with Contents read/write, required Metadata
   read-only, no webhook, and the staging setup callback. It is installed only
   on `CyanAutomation/matmetrics`; `GITHUB_APP_PRIVATE_KEY` is set as a staging
   Wrangler secret. Its App ID and install URL are set in `wrangler.jsonc`.
   The callback currently receives HTTP 403 from GitHub during installation
   lookup; investigate and resolve the error, then complete the stateful
   repository connection. Configure production App values and secret only at the
   production deployment gate. Do not use Vercel
   Preview deployments for this rollout. No separate MatMetrics staging origin
   is needed: keep the current production origin. The required Vercel
   Production cutover variables are absent; add them only after the staging
   import is reviewed, pointing `KEIKO_API_BASE_URL` at staging and allowing
   only the existing account. Redeploy MatMetrics Production so those values
   take effect.
2. **Finish staging validation.** The staging Worker is deployed and its
   `/healthz` and `/readyz` endpoints return HTTP 200. The sole existing
   MatMetrics account has been imported and its sessions and analytics match
   the source. A D1 snapshot, restore preview, confirmed restore, successful
   queue delivery, terminal retry handling, restore confirmation safeguard,
   and MCP/REST scope parity have been checked. Resolve the GitHub installation
   callback's HTTP 403 and verify repository backup/recovery; decide whether to
   run a controlled live DLQ handoff check. Synthetic identities in automated
   integration tests cover cross-tenant isolation; do not require or create a
   second live account. Do not add the production user ID to Keiko production
   before all staging gates pass.
3. **Pilot the existing account in staging.** The existing account's 37
   sessions were imported from MatMetrics, and the complete session list and
   analytics were compared with zero missing IDs or payload mismatches. Keep
   the Markdown copy and avoid dual writes. The Vercel Production cutover allowlist may include this ID only
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
