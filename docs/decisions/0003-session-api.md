# ADR 0003: Initial session REST contract

- Status: accepted for `/v1`
- Date: 2026-10-17

## Decision

The initial API uses JSON under `/v1`, with one canonical session payload and
Keiko-owned revision metadata returned beside it. Lists are ordered by date
descending and ID descending. Pagination uses an opaque keyset cursor and a
maximum page size of 100. Optional filters are date bounds, category, and
effort.

Single-record responses carry a strong ETag containing the record revision and
a user-scoped digest. Item GETs allow private revalidation with
`If-None-Match`; `PUT` and `DELETE` accept that ETag in `If-Match`. A missing
precondition returns 428 and a stale revision returns 412. All errors use
`{ "error": { "code", "message" },
"requestId" }`. The API does not accept GitHub ownership claims.

## Consequences

- Clients can detect and resolve concurrent edits instead of silently
  overwriting newer sessions.
- OpenAPI in the repository is the public contract; the Worker and future MCP
  transport call the same application service.
- The API contract can evolve without changing the MatMetrics session fields.
