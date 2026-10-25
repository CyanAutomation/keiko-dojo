# Operations and production gates

Keiko's local test configuration is self-contained. The staging and
production D1 databases, backup queues, and dead-letter queues are deployed;
all five deployed migrations are applied in both environments. Migration 0006
adds the GitHub operation-job table and is local only until the approved
Production rollout. Staging and production
contain the same 38 sessions and matching training analytics. The production
MatMetrics gateway passes authenticated create/read/delete smoke checks
(201/200/204, then 404), and a route-location check confirmed the active app
writes to production rather than staging. Production snapshot
`6699dd39-4dee-4c4d-9ab9-6a7b45617b16` completed with 38 records. The existing
GitHub repository still contains 38 Markdown files with exact payload parity.
The production GitHub App is restricted to `CyanAutomation/matmetrics`.
Production scheduled backups are enabled and staging scheduled backups are
disabled. A manual Production job completed at 20:15:49 UTC on 2026-10-25
with all 38 sessions and no error; this satisfies the pre-migration backup
gate. The next daily scheduled run remains due at 02:00 UTC on 2026-10-26.
The prior D1 restore rehearsal, scope checks, retry handling, DLQ checks, and
REST/MCP parity remain verified. The READY Vercel Production deployment
`dpl_Cv8Y96iTgUAuJZQcoBiADwrZBfqD` at commit
`b7a53ce3919b7b21928860b61833866b4e52d2d5` owns
`matmetrics-teal.vercel.app`. The staging Worker remains deployed at
[`keiko-dojo-staging.scheimann.workers.dev`](https://keiko-dojo-staging.scheimann.workers.dev); production is at
[`keiko-dojo.scheimann.workers.dev`](https://keiko-dojo.scheimann.workers.dev).

## Environment setup

- The staging and production D1 IDs and matching backup queues/dead-letter
  queues are recorded in `wrangler.jsonc`; all five migrations are applied
  in both databases. The Worker uses
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
- Vercel Production `KEIKO_API_BASE_URL` points to
  `https://keiko-dojo.scheimann.workers.dev`;
  `MATMETRICS_AUTH_FRONTEND_ORIGIN` remains
  `https://matmetrics-teal.vercel.app`; and
  `KEIKO_SESSION_CUTOVER_USER_IDS` still contains only the existing account's
  Better Auth user ID. These settings are Production-only and active in READY
  deployment `dpl_Cv8Y96iTgUAuJZQcoBiADwrZBfqD` at commit
  `b7a53ce3919b7b21928860b61833866b4e52d2d5`. The Vercel project has no
  custom-environment capacity, but this pilot does not require one. Keiko's
  staging and production `MATMETRICS_FRONTEND_URL` values remain the exact
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
  value `true` starts scheduled work. Local and production are enabled; staging
  is disabled. The first on-demand Production backup completed before
  scheduling was enabled; a second manual job completed with 38 sessions at
  20:15:49 UTC on 2026-10-25. Observe the next scheduled run as routine
  operations. Never enable the staging schedule while the Workers share
  session paths.
- `Keiko Dojo Staging` and `Keiko Dojo Production` are GitHub Apps owned by
  CyanAutomation. Both have repository Contents read/write, GitHub's required
  Metadata read-only permission, no webhook, and are installed only on
  `CyanAutomation/matmetrics`. Their Setup URLs use the matching staging or
  production callback. App IDs and install URLs are set in the corresponding
  Wrangler environments; each private key is stored only as its Worker's
  `GITHUB_APP_PRIVATE_KEY` secret. A stable `User-Agent` is sent on GitHub API
  requests. Callback query strings are redacted from Worker logs. Identical
  Markdown content is skipped during repeated backups to avoid duplicate GitHub
  commits. Both authenticated installation callbacks succeeded. The private
  keys are required for App JWTs; no long-lived installation token or webhook
  secret is stored. The
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
  automatically. Use the `production` selector for a production export after
  production migrations are applied.
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

The first single-account production cutover is complete. The staging Worker is
healthy, all five production migrations were applied before deployment, and the
existing account's 38 sessions were dry-run compared and imported. Session
payloads and analytics match staging and the Markdown repository. The deployed
MatMetrics app writes to production only, confirmed by a production read and a
staging 404 for a temporary smoke record; the record was then deleted.

The first production on-demand backup completed with a 38-session D1 snapshot.
A post-backup `--markdown-source` dry-run reported 38 exact matches, zero parse
failures, duplicate IDs, payload mismatches, missing records, or Keiko-only
records. Staging scheduled backups are disabled; production's daily schedule
is enabled. A second manual Production job completed with all 38 sessions at
20:15:49 UTC on 2026-10-25, before migration 0006 and the GitHub service move.
Observe the next scheduled run as routine operations.

For rollback, pause writes and confirm Keiko's latest snapshot and repository
Markdown copy. Remove the account from `KEIKO_SESSION_CUTOVER_USER_IDS` and
redeploy MatMetrics so its list API reads the Markdown repository again. Refresh
the checkout's `data/` directory from the latest `origin/main` backup commit,
then run `node --import tsx scripts/import-keiko-sessions.ts
--markdown-source` in dry-run mode while `KEIKO_API_BASE_URL` still points at
Keiko. Require zero parse failures, duplicate IDs, importable sessions,
payload mismatches, and `keikoOnly`; compare complete ID lists and analytics.
Do not use `--apply` in the rollback check. Keep the token issuance allowlist
active through comparison so the importer can read Keiko. If files are missing
or differ, keep writes paused and reconcile from the Markdown copy and Keiko's
D1 snapshot before switching storage. The importer only imports into Keiko; it
is not a reverse importer.

The workspace now implements GitHub health checks, sync-all, Log Doctor scans,
and confirmed fixes behind Keiko's authenticated API and Queue jobs. MatMetrics
uses the selected GitHub App installation for the allowlisted account, polls
tenant-scoped job status, and preserves the existing UI result contracts. The
Keiko session Markdown normalizer retains its lossless text payload. Tests and
type checks pass locally; this code and migration 0006 have not been deployed.

The manual Production backup gate passed at 20:15:49 UTC with all 38 sessions.
Apply migration 0006 and deploy Keiko and MatMetrics. Verify
connect/disconnect, health, 38-session sync, Log Doctor scan/preview/apply,
tenant-scoped polling, and Queue retry/DLQ behavior. After those Production
checks and a completed post-deployment backup, remove the Staging Worker, D1
database, queues and dead-letter queue, rate-limit namespaces, GitHub App
connection/secrets, Wrangler environment, and staging scripts. Training-plan
insights and AI features remain in MatMetrics until the data-use policy is
approved.

## Monitoring

Worker request logs contain the request ID, environment, method, normalized
path, status, and duration. They omit bearer tokens, cookies, and session
payloads. Backup errors use stable error codes; GitHub API response bodies and
credentials are not logged.

## Remaining service moves

MatMetrics continues to own training-plan insights and AI features. The
GitHub-service move is implemented locally and awaits the approved Production
migration and deployment. Do not send session data to an AI provider until the
data-use policy is approved.
