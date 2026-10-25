# Operations and production gates

Keiko's local test configuration is self-contained. Separate staging and
production D1 databases, backup queues, and dead-letter queues are provisioned.
As of 2026-10-25, all five migrations are applied to staging and
`/healthz` and `/readyz` return HTTP 200. Staging contains 38 sessions. A
fresh snapshot and GitHub backup completed, and the repository now contains
38 unique valid Markdown files with zero parse failures, duplicate IDs, or
session-payload mismatches against staging D1. The lossless backup format is
covered by MatMetrics parser tests. The earlier confirmed restore, isolated
SQL recovery rehearsal, REST/MCP analytics parity, scope denials, retry
handling, and DLQ checks remain verified. The staging GitHub App is connected
only to `CyanAutomation/matmetrics`. Vercel Production is configured for the
single-account staging pilot, and Vercel ignores Keiko backup commits. The
READY Production deployment `dpl_EVWexwXGmphjGSwdqAQDtHpg1mFu` at commit
`51c6476d72a46a9b401c4bdef63b9ae008c21422` owns
`matmetrics-teal.vercel.app`; signed-in Training History loads all 38
sessions. A synthetic CRUD smoke check found that the deployed MatMetrics
gateway turns Keiko's successful `204` delete into `503`. The local gateway
fix and regression test pass, but the fix still needs release before the
authenticated write gate is closed. Production D1 has no Keiko application
tables, and no production Worker deployment or account cutover exists. The
staging Worker is deployed at
[`keiko-dojo-staging.scheimann.workers.dev`](https://keiko-dojo-staging.scheimann.workers.dev).

## Environment setup

- The staging and production D1 IDs and matching backup queues/dead-letter
  queues are recorded in `wrangler.jsonc`. Keep production D1 unmigrated until
  staging and recovery validation pass. The Worker uses
  up to five retries and sends messages that exceed the retry limit to the
  configured dead-letter queue. Inspect and redrive dead-letter messages only
  after resolving the failure cause.
- Staging and production both use `https://matmetrics-teal.vercel.app/api/auth/jwks`,
  the public MatMetrics auth proxy backed by the existing Auth Worker, with
  issuer `https://matmetrics-teal.vercel.app`. Use that proxy for `AUTH_JWKS_URL`;
  a worker-to-worker request to the Auth Worker's `workers.dev` URL returned
  HTTP 404 from Keiko staging, while the public proxy returned HTTP 200. Keep `AUTH_AUDIENCE` exactly
  `keiko-dojo-api`. No separate MatMetrics origin or Vercel Preview deployment
  is needed for the single-account pilot: the current production origin is
  already the exact origin configured for Keiko and the Auth Worker.
- For the controlled single-account staging pilot, the Vercel Production variables
  `KEIKO_API_BASE_URL` to the staging Keiko Worker,
  `MATMETRICS_AUTH_FRONTEND_ORIGIN` to `https://matmetrics-teal.vercel.app`,
  and `KEIKO_SESSION_CUTOVER_USER_IDS` to only the existing account's Better
  Auth user ID. The variables are configured for Production only and point at
  the staging Worker. These values are active in the READY Production
  deployment `dpl_BpKUPpffsdTnvVEQFwFCrsEdSkzH` at commit
  `438f2ff34477676769238f2ff41956e4d06d8a56`. The current
  Vercel project has no custom-environment capacity, but this pilot does not
  require one. Keiko's staging `MATMETRICS_FRONTEND_URL` remains the exact
  production MatMetrics origin for CSRF and callback checks.
- The MatMetrics Vercel project has an Ignored Build Step that exits successfully
  for Git commit messages beginning `Keiko Dojo backup `, so routine Markdown
  backups do not rebuild Production. Other Git commits continue through the
  regular deployment path.
- Keep the unique rate-limit namespaces declared for each environment in
  `wrangler.jsonc`. The deployed staging namespaces are unique across the
  current Cloudflare account's Worker scripts. Keiko enforces per-user limits
  of 300 reads/minute, 120 session writes/minute, and 10 backup/restore
  writes/minute. Local development and the Workers test
  simulator skip rate-limit bindings. Deployed counters are per Cloudflare
  location and eventually consistent, so treat them as abuse controls rather
  than strict global quotas; monitor 429 responses in Workers Observability.
- `SCHEDULED_BACKUPS_ENABLED` is a fail-closed cron switch: only the literal
  value `true` starts scheduled work. Local and staging are configured `true`;
  production is configured `false` until production cutover. Before the first
  production backup writes to the shared repository, disable and verify the
  staging cron. Keep the production cron disabled until an on-demand production
  backup has completed and been checked, then enable production. Never run both
  schedules while the Workers share session paths.
- The staging GitHub App `Keiko Dojo Staging` is registered for the
  CyanAutomation account with repository Contents read/write (and GitHub's
  required Metadata read-only permission), no webhook, and Setup URL
  `https://keiko-dojo-staging.scheimann.workers.dev/v1/backups/github-installation/callback`.
  Its App ID and install URL are set in the staging Wrangler environment and
  it is installed only on `CyanAutomation/matmetrics`; its private key is set
  as the staging Worker secret `GITHUB_APP_PRIVATE_KEY`. A stable `User-Agent`
  is sent on GitHub API requests; this resolved the
  installation lookup rejection. Callback query strings are redacted from
  Worker logs. Identical Markdown content is skipped during repeated backups
  to avoid duplicate GitHub commits. The stateful Keiko
  authenticated installation callback succeeds and the staging backup job has
  completed. Configure production App values and private key only at the
  production deployment gate.
  The private key is required for GitHub App JWTs; no
  long-lived installation token or extra webhook secret is used. The
  installation endpoint returns `503` until the App ID, install URL, and
  private key are configured; placeholder IDs and install URLs are rejected.
- Apply migrations before deployment. Keep MatMetrics' `matmetrics-data`
  database separate from Keiko's D1.

## Identity and request boundary

- Better Auth remains the identity provider and signer. MatMetrics first
  verifies its existing `matmetrics-api` bearer token, then asks the fixed
  Auth Worker to validate the allowlisted session cookie and compare the
  Better Auth user ID with the bearer user ID.
- The Auth Worker issues an EdDSA token with audience `keiko-dojo-api`, the
  requested allowlisted scopes, matching `sub` / `appUserId`, and a maximum
  five-minute lifetime. MatMetrics validates those claims and forwards only
  that token to Keiko.
- The session cookie is sent only to `CLOUDFLARE_AUTH_WORKER_URL`; redirects
  are rejected. Requests require the exact MatMetrics `Origin` and
  `Sec-Fetch-Site: same-origin`. The issuance endpoint is outside the
  browser-facing `/api/auth/*` rewrite.
- Keep the Auth Worker URL, Keiko API URL, MatMetrics origin, and user cutover
  list server-side. Never put them under `NEXT_PUBLIC_*`.
- Keiko requires the Keiko audience and an operation-specific scope. REST and
  MCP tools use the same verified subject and application service.

## Backups and restores

- Session create/update/delete requests write to D1 without contacting GitHub.
- On-demand backup requests and scheduled jobs enter the Cloudflare Queue.
  The consumer stores a checksummed D1 snapshot and writes one Markdown file
  per session into the one selected GitHub repository using an ephemeral
  repository-scoped installation token. Files use KeikoTracker's existing
  MatMetrics format and path: `data/YYYY/MM/YYYYMMDD-matmetrics-<session-id>.md`
  with YAML frontmatter and the Techniques Practiced, Session Description, and
  Notes sections. Repeated backups update each session file; GitHub history
  retains prior versions.
- A Keiko account can connect one selected repository. Installations with
  all-repository access or multiple selected repositories are rejected. The
  API can disconnect the installation immediately; users can also uninstall
  the GitHub App from GitHub to revoke the App grant.
- `GET /v1/backups/{snapshotId}/restore-preview` reports the backup date,
  record count, and number of current records that will be protected as newer.
  `POST /v1/backups/{snapshotId}/restore` requires `{"confirm":true}` and
  merges the snapshot without deleting records or overwriting records newer
  than the snapshot. Every preview and restore is recorded.
- The MatMetrics repository is the separate session-data backup and rollback
  source. No encrypted D1 SQL export needs to be retained outside Cloudflare.
  Keiko D1 snapshots and the rehearsed restore provide database-level recovery;
  the API's merge restore preserves records newer than a snapshot.
- Run `npm run backup:rehearse -- staging /secure/path/keiko-staging.sql --confirm-export`
  to export a complete remote D1 database, restore the SQL into a temporary
  isolated local D1 database, and report row counts for all application tables.
  Wrangler warns that the D1 database may be unavailable during export, so run
  it in a maintenance window. The explicit `--confirm-export` argument
  prevents an unattended run. The script leaves a temporary export at the
  requested path with mode `0600`; remove that file after the rehearsal. It is
  not a required retained backup. The temporary rehearsal database is removed
  automatically. Use the `production` selector after production migrations
  exist.
- Keep the original Markdown repository through each account's rollback
  window. Keiko writes each session as a Markdown file in the same
  `data/YYYY/MM/` layout, with a stable session ID in the filename and a
  versioned lossless text payload that MatMetrics' Markdown reader restores.
  Before rollback,
  pause writes and confirm Keiko's latest backup job completed. Remove the
  user's ID from `KEIKO_SESSION_CUTOVER_USER_IDS` and redeploy MatMetrics so
  its list API reads the legacy Markdown repository again. Refresh the
  MatMetrics checkout's `data/` directory from the latest `origin/main` backup
  commit, then run `node --import tsx scripts/import-keiko-sessions.ts
  --markdown-source` in dry-run mode while `KEIKO_API_BASE_URL` still points at
  Keiko. The `--markdown-source` option compares repository files with Keiko;
  the default API source would read Keiko on both sides after cutover. The
  check must show zero parse
  failures, duplicate IDs, importable sessions, payload mismatches, and
  `keikoOnly`. Do not pass `--apply` in this rollback check. Keep the user's
  Auth Worker token issuance allowlist active through the comparison so the
  importer can read Keiko. The `keikoOnly` count detects sessions present in
  Keiko but absent from Markdown. Also compare the complete ID lists and
  analytics from the Markdown-backed API and Keiko. If any files are
  missing or payloads differ, keep writes paused and reconcile from the
  existing MatMetrics Markdown copy and Keiko's D1 snapshot before switching
  storage. The existing importer is a
  comparison/import into Keiko, not a reverse importer, so do not use it to
  restore Keiko data into D1.

## Cutover procedure

1. Confirm the staging deployment and migration state. The sole existing
   MatMetrics account's session and analytics parity, D1 snapshot/restore,
   restore confirmation protection, successful queue delivery, terminal retry
   handling, live DLQ handoff and cleanup, and MCP/REST scope parity have been
   verified. The latest staging backup has 38 sessions and the repository has
   38 unique Markdown records with exact payload and analytics parity.
   Keiko's automated integration tests use
   synthetic identities to verify tenant isolation; a second live account is
   not required.
2. From the MatMetrics repository root, run `npm run test:keiko:import`. Before
   the account is routed to Keiko, the default importer source can read the
   legacy MatMetrics API. After cutover, refresh `data/` from the latest
   `origin/main` backup commit and use
   `node --import tsx scripts/import-keiko-sessions.ts --markdown-source` for
   dry-run comparison. Review parse failures, duplicate IDs, payload
   mismatches, and existing records. Run with `--apply` only when an import is
   intended and the missing records have been reviewed. The importer source
   lives in [CyanAutomation/matmetrics](https://github.com/CyanAutomation/matmetrics/blob/main/scripts/import-keiko-sessions.ts).
3. Vercel Production points the single-account pilot to staging, and signed-in
   reads load all 38 sessions. The repository copy matches staging D1 exactly.
   Release the MatMetrics fix for successful bodyless Keiko deletes, then
   verify authenticated reads and writes through the deployed app. Keep the
   original Markdown copy and the cutover allowlist limited to the existing
   account. Do not switch the API base to Keiko Production until this deployed
   CRUD gate and recovery checks pass.
4. After all staging/recovery checks pass, apply migrations to production D1
   and deploy Keiko. Export the existing account data, repeat the importer
   dry-run/review/apply against production, compare session and analytics
   parity, then switch the Vercel Production `KEIKO_API_BASE_URL` to the
   production Worker for the already-allowlisted ID. Keep the allowlist limited
   to that one verified Better Auth user ID. Production scheduled backups stay
   disabled during the initial cutover. Before the first production backup
   writes to the shared repository, deploy staging with
   `SCHEDULED_BACKUPS_ENABLED=false` and verify it is disabled. Run a
   production backup on demand and verify it. Only then deploy production
   with `SCHEDULED_BACKUPS_ENABLED=true`; never leave both schedules active.
5. Do not dual-write. If rolling back, confirm Keiko's latest D1 snapshot and
   repository Markdown copy, reconcile new writes against Markdown, then remove
   the account from the allowlist.
   Keep the rollout at this account until recovery validation and sanitized
   logs show no unexpected authorization, queue, or GitHub errors. Reassess
   broader rollout when another MatMetrics account is onboarded.

## Monitoring

Worker request logs contain the request ID, environment, method, normalized
path, status, and duration. They omit bearer tokens, cookies, and session
payloads. Backup errors use stable error codes; GitHub API response bodies and
credentials are not logged.

## Remaining service moves

MatMetrics continues to own training-plan insights and AI features. GitHub
sync, health, and Log Doctor operations have not yet moved behind Keiko; move
them after the single-account production session cutover is stable if Keiko is
to become the shared backend for those services. Do not send session data to
an AI provider until the data-use policy is approved.
