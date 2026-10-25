# Operations and Production gates

## Current Production state

The single-account Production cutover and GitHub-service move are complete.
The Production Keiko Worker and MatMetrics app pass health, readiness, and
session smoke checks. Production D1 contains all 38 sessions. The latest
post-deployment backup completed at 20:28:49 UTC on 2026-10-25 with a
38-session snapshot. The selected `CyanAutomation/matmetrics` repository has
all 38 session files, and the Production Log Doctor scan found 38 valid files
and no invalid files. Production scheduled backups run daily at 02:00 UTC.

MatMetrics Production serves `matmetrics-teal.vercel.app` and sends the
allowlisted account to `https://keiko-dojo.scheimann.workers.dev`. The current
Keiko Worker version is `5e2edcc7-d2f4-4a35-a434-6a164f5d199a`; the current
READY Vercel Production deployment is
`dpl_DD42r7ZcwB6EVQ8pW2ARX8SFLY8r` at commit
`9846c37c1697362f32174754bb53a0e8627c985c`.

Before retirement, the Staging D1 database held a duplicate 38-session dataset
and no pending backup jobs. Both Staging queues had zero backlog. The Staging
Worker, D1 database (`7002a569-f450-4050-bb2a-b4cba208bf59`), primary queue
(`keiko-dojo-backups-staging`), and dead-letter queue
(`keiko-dojo-backups-staging-dlq`) have since been deleted. The Worker had only
the `GITHUB_APP_PRIVATE_KEY` secret; deleting it removed that Keiko-side secret.
The Production Worker, D1 database, and queues remain present. The Staging
GitHub App installation still needs revocation; GitHub requires a fresh
sudo-mode authentication to reach its uninstall setting. The Production App
installation is separate and remains active.

## Environment setup

- Local development uses the local D1 binding and local backup queues in
  `wrangler.jsonc`. Production has its own D1 binding, backup queue, dead-letter
  queue, and unique rate-limit namespace IDs. Staging configuration and
  resources have been removed. Workers Rate Limiting namespace IDs are
  user-defined binding identifiers rather than separately managed Cloudflare
  resources; the Staging bindings are removed from Wrangler and the deleted
  Worker no longer references them.
- Vercel Production `KEIKO_API_BASE_URL` points to
  `https://keiko-dojo.scheimann.workers.dev`;
  `MATMETRICS_AUTH_FRONTEND_ORIGIN` is
  `https://matmetrics-teal.vercel.app`; and
  `KEIKO_SESSION_CUTOVER_USER_IDS` contains only the existing account's Better
  Auth user ID. These are Production settings. Keiko's `MATMETRICS_FRONTEND_URL`
  and Auth/JWKS settings use the same Production MatMetrics origin.
- The MatMetrics Vercel project has an Ignored Build Step that skips commits
  beginning `Keiko Dojo backup `, so routine Markdown backups do not rebuild
  Production. Other commits continue through the regular deployment path.
- Keiko enforces per-user limits of 300 reads/minute, 120 session writes/minute,
  and 10 backup/restore writes/minute. Local development and the Workers test
  simulator skip rate-limit bindings. Deployed counters are per Cloudflare
  location and eventually consistent, so treat them as abuse controls rather
  than strict global quotas; monitor 429 responses in Workers Observability.
- `SCHEDULED_BACKUPS_ENABLED` is a fail-closed cron switch: only the literal
  value `true` starts scheduled work. Local and Production are enabled.
- The Production GitHub App is restricted to
  `CyanAutomation/matmetrics`; its private key is stored only as the Keiko
  Worker's `GITHUB_APP_PRIVATE_KEY` secret. Installation tokens are short-lived,
  repository-scoped, and never stored. Callback query strings are redacted from
  Worker logs. Identical Markdown content is skipped during repeated backups.
- Apply Production migrations before deploying a Worker change. Keep
  MatMetrics' `matmetrics-data` database separate from Keiko's D1.

## Identity and request boundary

- Better Auth remains the identity provider and signer. MatMetrics first
  verifies its existing `matmetrics-api` bearer token, then asks the fixed Auth
  Worker to validate the allowlisted session cookie and compare the Better Auth
  user ID with the bearer user ID.
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
- On-demand backup requests and scheduled jobs enter the Cloudflare Queue. The
  consumer stores a checksummed D1 snapshot and writes one Markdown file per
  session into the selected GitHub repository using an ephemeral,
  repository-scoped installation token. Files use KeikoTracker's MatMetrics
  format and path `data/YYYY/MM/YYYYMMDD-matmetrics-<session-id>.md` with YAML
  frontmatter and the Techniques Practiced, Session Description, and Notes
  sections. Repeated backups update each session file; GitHub history retains
  prior versions.
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
- Run `npm run backup:rehearse -- production /secure/path/keiko-production.sql --confirm-export`
  to export Production D1, restore the SQL into a temporary isolated local D1
  database, and report row counts for all application tables. Wrangler warns
  that D1 may be unavailable during export, so run it in a maintenance window.
  The explicit `--confirm-export` argument prevents an unattended run. The
  script leaves a temporary export at the requested path with mode `0600`;
  remove that file after the rehearsal. It is not a required retained backup.
  The temporary rehearsal database is removed automatically.
- Keep the original Markdown repository through each account's rollback window.
  Keiko writes each session as a Markdown file in the same `data/YYYY/MM/`
  layout, with a stable session ID in the filename and a versioned lossless text
  payload that MatMetrics' Markdown reader restores. Before rollback, pause
  writes and confirm Keiko's latest backup job completed. Remove the user's ID
  from `KEIKO_SESSION_CUTOVER_USER_IDS` and redeploy MatMetrics so its list API
  reads the legacy Markdown repository again. Refresh the MatMetrics checkout's
  `data/` directory from the latest `origin/main` backup commit, then run
  `node --import tsx scripts/import-keiko-sessions.ts --markdown-source` in
  dry-run mode while `KEIKO_API_BASE_URL` still points at Keiko. The check must
  show zero parse failures, duplicate IDs, importable sessions, payload
  mismatches, and `keikoOnly`. Do not pass `--apply` in this rollback check.
  Keep the Auth Worker token issuance allowlist active through the comparison so
  the importer can read Keiko. Also compare the complete ID lists and analytics
  from the Markdown-backed API and Keiko. If files are missing or payloads
  differ, keep writes paused and reconcile from the existing MatMetrics
  Markdown copy and Keiko's D1 snapshot before switching storage. The importer
  is not a reverse importer and must not be used to restore Keiko data into D1.

## Production cutover verification

The existing account's 38 sessions were dry-run compared and imported. Session
payloads and analytics matched the Markdown repository. The deployed MatMetrics
app writes to Production only; authenticated create/read/delete returned
201/200/204 and a follow-up read returned 404. The deployed MatMetrics gateway
handles Keiko's bodyless 204 response.

The manual pre-migration Production backup completed at 20:15:49 UTC on
2026-10-25 with a 38-session snapshot. After migration 0006 and the Production
deployments, the selected-repository health check succeeded, all 38 sessions
synced to GitHub, Log Doctor checked 38 files (38 valid, 0 invalid), and a
second Production snapshot completed at 20:28:49 UTC with all 38 sessions.

For rollback, pause writes and confirm Keiko's latest snapshot and repository
Markdown copy. Follow the rollback steps in [Backups and restores](#backups-and-restores).

## Monitoring

Worker request logs contain the request ID, environment, method, normalized
path, status, and duration. They omit bearer tokens, cookies, and session
payloads. Backup errors use stable error codes; GitHub API response bodies and
credentials are not logged.

MatMetrics continues to own training-plan insights and AI features. Do not send
session data to an AI provider until the data-use policy is approved.
