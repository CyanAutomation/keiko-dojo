---
name: backup-and-restore
description: Safely change D1 snapshots, queue delivery, the single-repository GitHub App integration, and merge restores.
tags: [keiko-dojo, backup, restore, cloudflare-queues, github-app]
relatedSkills: [identity-and-tenant-security, cloudflare-operations]
---

# Backup and Restore

Use this skill when changing on-demand or scheduled backups, D1 snapshots,
Cloudflare Queue handling, GitHub App installation, or restore behavior.

## Read first

- `docs/operations.md`, especially **Backups and restores** and **Monitoring**.
- `src/http/backups.ts`, `src/domain/backup-snapshot.ts`, and
  `src/integrations/github-app.ts`.
- `migrations/0002_create_backup_tables.sql` and later backup migrations.
- Existing scenarios in `test/api.integration.test.ts`,
  `test/backup-snapshot.test.ts`, and `test/github-app.integration.test.ts`.

## Queue and snapshot rules

- Session create/update/delete stays independent of GitHub and the backup
  queue. Backup failures must not block normal D1 session writes.
- Treat Queue delivery as at-least-once. A job can be delivered more than
  once or concurrently; use the persisted job/snapshot identity and guarded
  state updates so one job does not create duplicate snapshots or writes.
- Preserve scheduled-job deduplication and recovery of stale dispatches. The
  Wrangler consumer currently retries up to five times and sends exhausted
  messages to the environment's dead-letter queue.
- Validate snapshots before preview, restore, or retrying a GitHub write:
  verify the SHA-256 checksum, canonical metadata, row count, unique session
  IDs, valid session payloads, and agreement between row metadata and payload.
- Restore remains an explicit merge. Require exactly `{"confirm":true}`;
  preserve records newer than the snapshot and records absent from it. Do not
  delete current records as part of snapshot restore. Record both previews
  and applied restores in `restore_activity`.
- Keep all job, snapshot, and installation lookups scoped to the verified
  account. See `identity-and-tenant-security`.

## GitHub App boundary

- A user may connect one installation with selected access to exactly one
  repository. Reject all-repository access and installations selecting more
  than one repository.
- Create short-lived installation tokens scoped to the selected repository
  and required Contents permissions. Never persist those tokens; store the
  App private key only as a Wrangler secret.
- Keep callback state unpredictable, hashed at rest, short-lived, bound to
  the initiating account, and consumable once. Redirect only to the fixed
  configured frontend origin.
- Preserve the existing KeikoTracker Markdown path and format documented in
  `docs/operations.md` unless an intentional compatibility change updates the
  export contract and tests.
- Do not log GitHub response bodies, private keys, or tokens. Report stable
  error codes instead.

## Verification

Extend integration tests for duplicate delivery, dispatch failure/recovery,
corrupt snapshots, restore confirmation and preservation, installation
selection, token scope, and one-time callback state as appropriate. The
repository CI commands are `npm test`, `npm run typecheck`, and
`npm run check:migrations`.
