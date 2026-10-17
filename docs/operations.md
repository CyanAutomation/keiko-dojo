# Operations and production gates

Keiko's local test configuration is self-contained. Staging and production
remain disabled until their D1, Queue, auth, MatMetrics, and GitHub App
resources have been provisioned and recovery has been exercised.

## Environment setup

- Create a separate Keiko D1 database for staging and production and replace
  the placeholder IDs in `wrangler.jsonc`.
- Create the matching backup queues and dead-letter queues. The Worker uses
  up to five retries and sends messages that exceed the retry limit to the
  configured dead-letter queue. Inspect and redrive dead-letter messages only
  after resolving the failure cause.
- Set each environment's Better Auth JWKS URL and issuer to the matching
  MatMetrics Auth Worker. Keep `AUTH_AUDIENCE` exactly `keiko-dojo-api`.
- Set `MATMETRICS_FRONTEND_URL` to that environment's exact MatMetrics origin.
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
  long-lived installation token or extra webhook secret is used.
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

1. Deploy and validate staging with two test users, including mismatched
   bearer/cookie identities, rejected origins, import parity, analytics,
   backup recovery, queue retry/DLQ behavior, restore protection, and MCP/REST
   scope parity.
2. Run `scripts/import-keiko-sessions.ts` in dry-run mode for a pilot account.
   Review parse failures, duplicate IDs, payload mismatches, and existing
   records. Run with `--apply` only after review.
3. Compare the complete Keiko session list and analytics against the source.
   Only then add the verified Better Auth user ID to the MatMetrics
   `KEIKO_SESSION_CUTOVER_USER_IDS` server-side allowlist.
4. Do not dual-write. If rolling back, export current D1 first, reconcile new
   writes against Markdown, then remove the account from the allowlist.
5. Expand the pilot only after recovery validation and sanitized logs show no
   unexpected authorization, queue, or GitHub errors.

## Monitoring

Worker request logs contain the request ID, environment, method, normalized
path, status, and duration. They omit bearer tokens, cookies, and session
payloads. Backup errors use stable error codes; GitHub API response bodies and
credentials are not logged.

## Remaining service moves

MatMetrics continues to own training-plan insights and AI features. GitHub
sync, health, and Log Doctor operations have not yet moved behind Keiko and
must be migrated before Keiko is the shared backend for those services. Do not
send session data to an AI provider until the data-use policy is approved.
