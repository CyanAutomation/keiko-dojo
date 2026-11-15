---
name: github-markdown-sync
description: Safely change deferred session-to-Markdown sync, Cloudflare Queue delivery, and the single-repository GitHub App integration.
tags: [keiko-dojo, github-markdown, cloudflare-queues, github-app]
relatedSkills: [identity-and-tenant-security, cloudflare-operations]
---

# GitHub Markdown Sync

Use this skill when changing session-to-GitHub Markdown sync, Cloudflare Queue
handling, GitHub App installation, repository reconciliation, or tenant-scoped
GitHub operation jobs. The selected repository is a second-brain Markdown copy,
not a D1 snapshot or restore source.

## Read first

- `docs/operations.md`, especially **GitHub Markdown sync** and **Monitoring**.
- `src/http/backups.ts`, `src/http/github-sync.ts`,
  `src/http/github-operations.ts`,
  `src/application/github-session-sync-queue.ts`, and
  `src/integrations/github-app.ts`.
- `migrations/0007_github_session_sync.sql` and the session/installation
  migrations that define its trigger dependencies.
- Existing scenarios in `test/api.integration.test.ts` and
  `test/github-app.integration.test.ts`.
- For health, sync-all, and Log Doctor job behavior, inspect the relevant
  operation routes, queue consumer, migration, and integration scenarios.

## Queue and sync rules

- D1 triggers persist per-session dirty work atomically with successful session
  creates, updates, and deletes. The request path only sends a delayed wake-up;
  queue failure must never turn a successful D1 write into an API failure.
- Coalesce writes until 60 seconds after the latest session mutation. Keep one
  durable sync state per user and one dirty item per session, so repeated edits
  replace earlier pending work.
- Treat Queue delivery as at-least-once. Use a persisted lease, generation
  checks, idempotent Markdown writes, and cron recovery for failed dispatches
  and expired leases. Preserve unsynced dirty items across retries.
- The initial connection and explicit sync-all request require a full
  reconciliation: write current session Markdown and remove stale managed
  session paths. Session date changes move a file; session deletes remove it.
- Restrict full reconciliation to the selected repository and Keiko session
  paths. Do not treat repository contents as input for D1 restoration.
- Preserve the existing Markdown path and format documented in
  `docs/operations.md` unless an intentional compatibility change updates the
  export contract and tests.

## GitHub App boundary

- A user may connect one installation with selected access to exactly one
  repository. Reject all-repository access and installations selecting more
  than one repository.
- Create short-lived installation tokens scoped to the selected repository and
  required Contents permissions. Never persist tokens; store the App private
  key only as a Wrangler secret.
- Keep callback state unpredictable, hashed at rest, short-lived, bound to the
  initiating account, and consumable once. Redirect only to the fixed
  configured frontend origin.
- Do not log GitHub response bodies, private keys, or tokens. Report stable
  error codes instead.

## GitHub operation jobs

- Keep job creation and result access scoped to the verified user ID. A caller
  must not read or operate on another user's job by supplying its ID.
- Preserve narrow scopes: health checks and Log Doctor scans use
  `github:read`; sync-all and confirmed Log Doctor fixes use `github:write`.
- Treat queue messages as untrusted and potentially duplicated. Validate the
  job, owner, operation type, payload, and allowed managed Markdown paths before
  making repository changes.
- Keep destructive Log Doctor fixes explicitly confirmed, bounded by the
  existing file limit, and safe to retry. Preserve dry-run behavior and report
  stable job states and error codes.
- Keep worker failures, queue dispatch failures, attempts, and terminal job
  states observable without logging repository contents or credentials.

## Verification

Use integration tests for delayed coalescing, duplicate delivery, dispatch
failure and recovery, initial reconciliation, path moves/deletes, installation
selection, token scope, one-time callback state, tenant-scoped job access,
operation authorization, queue failure, and safe Log Doctor fixes as
appropriate. Run the focused tests and the repository CI checks defined in
`.github/workflows/ci.yml`.
