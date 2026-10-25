# ADR 0001: Worker runtime and session storage

- Status: accepted for the first vertical slice
- Date: 2026-10-17

## Decision

Keiko Dojo runs as an independently deployed TypeScript Cloudflare Worker.
Cloudflare D1 is its authoritative session store, reached only through a D1
binding. Local development and Production use separate databases. A temporary
Staging environment used during the initial rollout was retired after the
Production cutover. MatMetrics' `matmetrics-data` database is not reused.

Session payloads keep the MatMetrics fields and categories. Keiko stores the
verified stable user ID, record revision, and timestamps as server-owned
metadata outside the editable session payload. The repository interface takes
the verified user ID for every operation; D1 queries include it in every
read, insert, update, and delete.

## Consequences

- Worker handlers, application services, and the D1 adapter remain separate.
- D1 statements use prepared parameters; the administrative REST API is not
  used by request handlers.
- GitHub remains an optional backup/import integration and does not participate
  in ordinary session reads or writes.
- A remote environment cannot deploy until its D1 database and identity
  provider URLs replace the Wrangler placeholders.
