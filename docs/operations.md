# Operations and production gates

Keiko's local test configuration is self-contained. Separate staging and
production D1 databases, backup queues, and dead-letter queues are provisioned.
The staging Worker is deployed at
[`keiko-dojo-staging.scheimann.workers.dev`](https://keiko-dojo-staging.scheimann.workers.dev)
and its health/readiness endpoints have been smoke-checked. End-to-end account
validation is incomplete. Production D1 remains empty and unmigrated, and there
is no production Worker deployment or account cutover.

## Environment setup

- The staging and production D1 IDs and matching backup queues/dead-letter
  queues are recorded in `wrangler.jsonc`. Keep production D1 unmigrated until
  staging and recovery validation pass. The Worker uses
  up to five retries and sends messages that exceed the retry limit to the
  configured dead-letter queue. Inspect and redrive dead-letter messages only
  after resolving the failure cause.
- Staging uses the existing MatMetrics Auth Worker's verified JWKS endpoint and
  the issuer `https://matmetrics-teal.vercel.app`. Keep `AUTH_AUDIENCE` exactly
  `keiko-dojo-api`. No separate MatMetrics origin or Vercel Preview deployment
  is needed for the single-account pilot: the current production origin is
  already the exact origin configured for Keiko and the Auth Worker.
- After the staging import is reviewed, set the Vercel Production variables
  `KEIKO_API_BASE_URL` to the staging Keiko Worker,
  `MATMETRICS_AUTH_FRONTEND_ORIGIN` to `https://matmetrics-teal.vercel.app`,
  and `KEIKO_SESSION_CUTOVER_USER_IDS` to only the existing account's Better
  Auth user ID. These variables are currently absent from the Vercel project.
  This routes that account's live MatMetrics session API calls to staging; do
  not enable the allowlist before importing and reviewing its data. Redeploy
  MatMetrics Production after saving the variables. The current
  Vercel project has no custom-environment capacity, but this pilot does not
  require one. Keiko's staging `MATMETRICS_FRONTEND_URL` remains the exact
  production MatMetrics origin for CSRF and callback checks.
- Keep the unique rate-limit namespaces declared for each environment in
  `wrangler.jsonc`. Keiko enforces per-user limits of 300 reads/minute, 120
  session writes/minute, and 10 backup/restore writes/minute. If the namespace
  IDs are already used in the Cloudflare account, assign unused positive
  integer IDs before deployment. Local development and the Workers test
  simulator skip rate-limit bindings. Deployed counters are per Cloudflare
  location and eventually consistent, so treat them as abuse controls rather
  than strict global quotas; monitor 429 responses in Workers Observability.
- Create a GitHub App with repository Contents read/write permission. Configure
  its callback as
  `https://<keiko-worker-origin>/v1/backups/github-installation/callback`.
  Set `GITHUB_APP_ID`, `GITHUB_APP_INSTALL_URL`, and the fixed frontend URL in
  Wrangler config. Store the App's private key with
  `wrangler secret put GITHUB_APP_PRIVATE_KEY --env staging` and the matching
  production command. The private key is required for GitHub App JWTs; no
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
- Before bulk imports and migrations, export D1 into protected storage and
  rehearse restore into an isolated database. The API's merge restore is not a
  replacement for an operator-controlled full database recovery.
- Keep the original Markdown repository through each account's rollback
  window. Export current Keiko D1 data before switching an account back.

## Cutover procedure

1. Deploy and validate staging with the sole existing MatMetrics account,
   including mismatched bearer/cookie identities, rejected origins, analytics,
   backup recovery, queue retry/DLQ behavior, restore protection, and MCP/REST
   scope parity. Keiko's automated integration tests use synthetic identities
   to verify tenant isolation; a second live account is not required.
2. From the MatMetrics repository root, export the current account data, run
   `npm run test:keiko:import`, then run
   `node --import tsx scripts/import-keiko-sessions.ts` in dry-run mode with
   the staging API configured. Review parse failures, duplicate IDs, payload
   mismatches, and existing records. Run with `--apply` only after review. The
   importer source lives in [CyanAutomation/matmetrics](https://github.com/CyanAutomation/matmetrics/blob/main/scripts/import-keiko-sessions.ts).
3. Compare the complete staging session list and analytics against the source,
   exercise rollback, and keep the original Markdown copy. After the reviewed
   staging import, set the Vercel production API base to the staging Worker and
   allowlist only the existing user for this controlled staging pilot. Switch
   the API base to Keiko production only after production migration and cutover
   checks pass. Keep the cutover allowlist limited to that one ID.
4. After all staging/recovery checks pass, apply migrations to production D1
   and deploy Keiko. Export the existing account data, repeat the importer
   dry-run/review/apply against production, compare session and analytics
   parity, then switch the Vercel Production `KEIKO_API_BASE_URL` to the
   production Worker for the already-allowlisted ID. Keep the allowlist limited
   to that one verified Better Auth user ID.
5. Do not dual-write. If rolling back, export current Keiko D1 first, reconcile
   new writes against Markdown, then remove the account from the allowlist.
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
