# Operations and Production gates

## Current Production state

The single-account Production cutover and GitHub-service move are complete.
The Production Keiko Worker and MatMetrics app pass health, readiness, and
session smoke checks. Production D1 contains all 38 sessions. The selected
`CyanAutomation/matmetrics` repository has all 38 session files, and the
Production Log Doctor scan found 38 valid files and no invalid files. The
automatic GitHub Markdown sync implementation and migration 0007 are local
changes and are not yet deployed. Until migration 0007 is applied, Production
still uses the previous sync behavior and its old D1 snapshot tables remain;
the migration drops those tables and requests a full repository reconciliation.

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
The Production Worker, D1 database, queues, GitHub App installation, and app
registration remain present. The Staging GitHub App installation and
registration have been deleted; the Production App is separate and untouched.

## Environment setup

- Local development uses the local D1 binding and local GitHub sync queue in
  `wrangler.jsonc`. Production has its own D1 binding, queue, dead-letter
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
  and 10 GitHub write requests/minute. Local development and the Workers test
  simulator skip rate-limit bindings. Deployed counters are per Cloudflare
  location and eventually consistent, so treat them as abuse controls rather
  than strict global quotas; monitor 429 responses in Workers Observability.
- A one-minute cron dispatches durable GitHub sync work when a queue wake-up
  failed or a worker lease expired. It does not create scheduled copies.
- The Production GitHub App is restricted to
  `CyanAutomation/matmetrics`; its private key is stored only as the Keiko
  Worker's `GITHUB_APP_PRIVATE_KEY` secret. Installation tokens are short-lived,
  repository-scoped, and never stored. Callback query strings are redacted from
  Worker logs. Identical Markdown content is skipped during repeated syncs.
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

## GitHub Markdown sync

- The selected GitHub repository is a second-brain Markdown copy, not a D1
  snapshot or D1 restore source. Keiko has no D1 snapshot/restore API.
- When a repository is connected, Keiko queues an initial full reconciliation.
  After that, D1 triggers persist dirty session IDs in the same transaction as
  each create, update, or delete. The queue waits 60 seconds after the most
  recent write for that account before syncing, coalescing rapid edits into the
  latest session content. A one-minute cron recovers missed queue dispatches
  and expired worker leases.
- GitHub sync failures leave dirty session IDs pending and never cause a
  successful D1 session write to fail. The scoped status endpoint and analytics
  status report whether work is pending, the next sync time, the last
  successful sync, and the last stable error code.
- Files use KeikoTracker's MatMetrics-compatible format and path
  `data/YYYY/MM/YYYYMMDD-matmetrics-<session-id>.md` with YAML frontmatter and
  the Techniques Practiced, Session Description, and Notes sections. Repeated
  syncs skip identical Markdown. A date change moves the managed file; a
  session delete removes it. Initial and explicit full syncs remove stale
  managed session Markdown files from the selected repository.
- A Keiko account can connect one selected repository. Installations with
  all-repository access or multiple selected repositories are rejected. The
  API can disconnect the installation immediately; users can also uninstall
  the GitHub App from GitHub to revoke the App grant.
- The existing `backup_snapshots`, `backup_jobs`, and `restore_activity` D1
  tables are removed by migration 0007. Applying the migration deletes the
  stored application snapshot rows and seeds a full sync for already connected
  GitHub accounts. It does not delete GitHub Markdown files.
- The Markdown-backed MatMetrics app may still read the same repository when
  its account is routed back to that app. That is an application storage
  cutover, not a Keiko D1 restore. Keep the repository available for that
  purpose; do not import it into Keiko D1 as a restore mechanism.

## Production cutover verification

The existing account's 38 sessions were dry-run compared and imported. Session
payloads and analytics matched the Markdown repository. The deployed MatMetrics
app writes to Production only; authenticated create/read/delete returned
201/200/204 and a follow-up read returned 404. The deployed MatMetrics gateway
handles Keiko's bodyless 204 response.

Before the GitHub sync redesign, a manually requested Production snapshot
completed at 20:15:49 UTC on 2026-10-25 and a second at 20:28:49 UTC. These are
historical events; the rows retained by the old application tables are removed
when migration 0007 is applied. The selected-repository health check and 38-file
GitHub sync succeeded after migration 0006, and Log Doctor found 38 valid files.

For an application storage rollback, pause writes and verify the complete
Markdown session set before routing the account back to MatMetrics. This does
not restore Keiko D1.

## Monitoring

Worker request logs contain the request ID, environment, method, normalized
path, status, and duration. They omit bearer tokens, cookies, and session
payloads. Backup errors use stable error codes; GitHub API response bodies and
credentials are not logged.

MatMetrics continues to own training-plan insights and AI features. Do not send
session data to an AI provider until the data-use policy is approved.
