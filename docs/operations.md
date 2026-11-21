# Operations and Production gates

## Current Production state

Release facts below were rechecked read-only on 2026-11-21. The detailed sync
state that follows is historical and was not queried again on that date.

- The latest deployed Keiko Worker version is
  `a7c66220-8a1d-4326-b7e0-0366b87e68c3`, created 2026-10-25 and still at
  100% traffic. It predates current `main` (`aa5ee1bc61254b93abe8d431844d1da031035dd`).
- Production D1 `keiko-dojo` (`750315f8-ef51-4d6e-86ea-41b076ec9de8`) records
  migrations `0001` through `0008`. A read-only schema query confirmed
  `session_create_idempotency` matches migration 0008, including the composite
  `(user_id, idempotency_key)` primary key. Session count was not rechecked.
- Workflow run
  [44420316195](https://github.com/CyanAutomation/keiko-dojo/actions/runs/44420316195)
  passed its CI checks and failed on its first production D1 query with
  Cloudflare code 7403; Worker deployment was skipped. The run had non-empty
  token input and the expected account ID. The exact token policy is not
  visible to repository automation, so its account scope and D1 permission
  still require owner verification.
- The connected Cloudflare identity could see the configured account, D1
  database, migration ledger, and Worker deployment. This is not evidence
  about the separate token stored in GitHub's `cloudflare` environment.
- The Production Queue list contains `keiko-dojo-backups` and
  `keiko-dojo-backups-dlq`; the primary queue reports one producer and one
  consumer. Message backlog was not queried.
- The protected deployment workflow now checks the configured account
  resources, expected Queue names, Worker deployment, D1 migration prefix, and
  migration 0008 schema before applying migrations. It verifies that all
  checked-in migrations are recorded before Worker upload. These reads do not
  prove D1 write or Worker script-edit access.
- Use one account-scoped API token with `D1 Edit` and `Workers Scripts Edit`
  permissions scoped to the Keiko Cloudflare account. The token must also be
  allowed to read the D1 and Worker endpoints used by preflight. Do not use a
  global API key or grant unrelated account permissions. If the token editor
  separates read and edit scopes, add the corresponding read scopes for
  preflight and edit scopes for migration/deployment.
- The workflow's permission/resource map is:

  | Operation | Cloudflare resource | Minimum permission |
  | --- | --- | --- |
  | Verify D1 database and read migration/schema state | Account D1 database `keiko-dojo` (`750315f8-ef51-4d6e-86ea-41b076ec9de8`) | D1 Read; D1 Edit also authorizes the query endpoints used by preflight |
  | Apply pending D1 migrations | Same D1 database | D1 Edit (D1 write) |
  | Verify Worker deployment status | Account Worker `keiko-dojo` | Workers Scripts Read; Workers Scripts Edit also authorizes deployment reads |
  | Verify existing Queue names | Account Queues `keiko-dojo-backups` and `keiko-dojo-backups-dlq` | Queues Read or Workers Scripts Read; Workers Scripts Edit is also accepted by the API |
  | Upload and deploy the Worker version | Account Worker `keiko-dojo` | Workers Scripts Edit |

  Cloudflare's current Workers authorization guide says deploying a Worker
  with existing D1/Queue bindings requires Worker Editor access; it does not
  require separate access to each bound resource. Keiko's queue and
  dead-letter resources must already exist. Do not grant Queue Edit or other
  resource permissions for this deployment unless Cloudflare reports a
  specific new requirement.
- GitHub owner must verify `CLOUDFLARE_ACCOUNT_ID` in the protected
  `cloudflare` environment and inspect the API token's account/resource
  restrictions and permissions. Workflow automation can confirm only that the
  variable and secret are present, then whether that token can read the target
  resources.
- Production deployment remains an explicit dispatch from `main` through the
  protected GitHub environment. No production migration or deployment was run
  for this assessment.

Historical sync state from 2026-11-18 (not rechecked on 2026-11-21):

- Production D1 had 39 sessions. The sync state was at generation 5 with
  `completed_generation = 0`, `full_sync_required = 1`, `last_synced_at = NULL`,
  `last_error = 'github_sync_failed'`, two pending dirty items, and no
  synced-file manifest rows. Its `next_sync_at` was stale.
- Nine `github_session_sync_failed` events were observed between 21:00:32 and
  22:17:31 UTC. They came from the `keiko-dojo-backups` queue and all reported
  `phase = session_contents`, `causeName = Error`, and `reason = other`.
  Existing Production logs do not expose enough detail to identify the
  underlying exception. The safe diagnostic logging change is pending release.

The automatic GitHub Markdown sync and migration 0007 are already present in
Production; do not treat the earlier 38-session cutover notes below as the
current sync state. MatMetrics Production serves `matmetrics-teal.vercel.app`
and routes the allowlisted account to
`https://keiko-dojo.scheimann.workers.dev`.

Before retirement, the Staging D1 database held a duplicate 38-session dataset
and no pending backup jobs. Both Staging queues had zero backlog. The Staging
Worker, D1 database (`7002a569-f450-4050-bb2a-b4cba208bf59`), primary queue
(`keiko-dojo-backups-staging`), and dead-letter queue
(`keiko-dojo-backups-staging-dlq`) have since been deleted. The Worker had only
the `GITHUB_APP_PRIVATE_KEY` secret; deleting it removed that Keiko-side secret.
The Production Worker, D1 database, queues, GitHub App installation, and app
registration remain present. The Staging GitHub App installation and
registration have been deleted; the Production App is separate and untouched.

## Production release procedure

Use the protected `Deploy Production` workflow after the owner has verified
the Cloudflare token policy:

1. Confirm required Keiko CI and workflow-quality checks are green for the
   reviewed `main` commit.
2. Confirm the D1 ledger is the expected migration prefix and migration 0008
   has the expected table schema. The read-only workflow preflight performs
   these checks and identifies pending checked-in migrations.
3. Verify the GitHub environment token is scoped to the Keiko Cloudflare
   account and has D1 Edit and Workers Scripts Edit permissions. Read-only
   preflight success does not establish write permission.
4. Obtain the approval required by the protected GitHub environment, then
   dispatch `Deploy Production` from `main`.
5. Let the workflow apply forward-only D1 migrations, verify the full remote
   migration ledger, then deploy the Worker with `keiko-release-sha:<commit>`
   as its Cloudflare version message.
6. Confirm the workflow's post-deploy read reports the expected Worker version
   ID at 100% traffic and the same release SHA before smoke testing. The
   Cloudflare deployment API exposes version IDs, annotations, and traffic
   percentages independently of the workflow runner.
7. Use an approved dedicated test account for keyed-create smoke tests. Verify
   first create; same-key/same-payload replay; same-key/different-payload
   `409 idempotency_key_reuse`; concurrent identical requests; replay after
   update and after delete; failed request without a ledger row; keyless legacy
   create; cross-user isolation; and no duplicate GitHub sync work on replay.
   Never use real training sessions. Record account ID only in the protected
   operator record, not in source logs or this document.
8. Monitor Keiko errors, migration results, and GitHub sync health. Record the
   workflow run, D1 ledger, Worker version ID, traffic percentage, smoke-test
   result, and monitoring window.

For rollback, route traffic back to the previously recorded Worker version and
confirm 100% allocation and health. Do not edit or roll back an applied D1
migration; use a forward-only compatibility migration if schema correction is
needed. Record the rollback version and reason. Keep any MatMetrics account
cutover decision separate from Keiko deployment.

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
- Full reconciliation is capped at 500 sessions. The query reads at most 501
  rows before rejecting an oversized sync, records `session_limit_exceeded`,
  and stops automatic retries until a later session change or explicit sync.
- GitHub GET responses with ETags are revalidated on repeat requests using a
  bounded, short-lived per-isolate cache scoped to the Keiko user, installation,
  and repository. Installation tokens are also reused per isolate only when
  GitHub supplies a valid expiry time; they are refreshed five minutes before
  expiry. These caches are best-effort and do not persist across Worker isolate
  eviction or deployment.
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

At the October 2026 cutover, 38 sessions were dry-run compared and imported.
Session payloads and analytics matched the Markdown repository. The deployed
MatMetrics app writes to Production only; authenticated create/read/delete
returned 201/200/204 and a follow-up read returned 404. The deployed MatMetrics
gateway handles Keiko's bodyless 204 response. Production now has 39 sessions;
see the current-state snapshot above for sync health.

Before the GitHub sync redesign, a manually requested Production snapshot
completed at 20:15:49 UTC on 2026-10-25 and a second at 20:28:49 UTC. These are
historical events; the rows retained by the old application tables are removed
when migration 0007 is applied. The selected-repository health check and 38-file
GitHub sync succeeded after migration 0006, and Log Doctor found 38 valid files.

For an application storage rollback, pause writes and verify the complete
Markdown session set before routing the account back to MatMetrics. This does
not restore Keiko D1.

## Phase 2B idempotency migration and rollout

Migration `0008_session_create_idempotency.sql` is additive. It creates the
durable, user-scoped create ledger; it does not rewrite session rows, revisions,
GitHub sync state, or existing data. Successful entries have no expiry and no
cleanup job.

Before a release, review and run `npm run check:migrations` against local D1,
then inspect the table definition and composite primary key with:

```sh
npx wrangler d1 execute keiko-dojo-local --local --command "PRAGMA table_info(session_create_idempotency)"
npx wrangler d1 execute keiko-dojo-local --local --command "PRAGMA index_list(session_create_idempotency)"
```

Production currently records migration 0008 as applied. Before a future
release, verify the remote migration list and use the main-only **Deploy
Production** workflow, which applies migrations before deploying the Worker.
Older MatMetrics clients remain compatible because the idempotency header is
optional. Do not deploy a new MatMetrics client while Keiko is still silently
ignoring the key.

If the Worker or MatMetrics release must be rolled back after applying 0008,
leave the additive table and its rows in place. An older Worker ignores the
ledger table, and old MatMetrics callers omit the header. Do not drop the table
or attempt to reverse the migration automatically; preserve it for a later
forward deployment.

To investigate an ambiguous create, correlate the HTTP `requestId` with the
structured `session_create_idempotency` outcome log. If a D1 inspection is
needed, use the authenticated user's verified ID and the key supplied by the
client to inspect the matching ledger row. Do not add raw keys, session
payloads, or user IDs to routine Worker logs.

## Monitoring

Worker request logs contain the request ID, environment, method, normalized
path, status, and duration. They omit bearer tokens, cookies, and session
payloads. GitHub sync failure events should include `phase`, the specific
GitHub operation (`installation_token`, `contents_get`, `contents_put`, or
`contents_delete`), GitHub request ID and response status when available,
exception name, transport cause code, stable error category, and a bounded,
redacted error summary. Never log GitHub response bodies, credentials, session
IDs, file paths, or session payloads. Alert when a sync remains incomplete or
`last_error` remains set for more than 15 minutes; inspect the operation and
GitHub request ID before retrying or changing repository state.

For this incident, deploy the diagnostic change and inspect one normal queue
retry before manually starting another sync. Once the cause is fixed, review the
managed stale paths that a full reconciliation would remove, then queue one
full sync. Verify `full_sync_required = 0`, `completed_generation = generation`,
`last_synced_at` is set, `last_error` is null, no dirty items remain, and the
manifest contains one row for every current D1 session.

MatMetrics continues to own training-plan insights and AI features. Do not send
session data to an AI provider until the data-use policy is approved.
