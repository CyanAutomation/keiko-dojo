---
name: session-api-contract
description: Change Keiko session behavior while keeping REST, storage, analytics, MCP, and published contracts aligned.
tags: [keiko-dojo, api, sessions, contract, d1]
relatedSkills: [identity-and-tenant-security, github-markdown-sync]
---

# Session API Contract

Use this skill when changing session fields, validation, CRUD behavior,
pagination, revisions, analytics, or the API documentation and fixtures.

## Read first

- `docs/session-contract.md` for field validation, ETags, pagination, and
  compatibility rules.
- `openapi.yaml` for the public HTTP contract.
- `docs/decisions/0003-session-api.md` for versioning and concurrency choices.
- Relevant implementation in `src/domain/session.ts`,
  `src/application/session-service.ts`, `src/http/sessions.ts`, and
  `src/storage/d1-session-repository.ts`.

## Invariants

- Keep session payload validation and normalization in the domain layer. The
  API contract currently preserves the MatMetrics fields and canonical error
  messages described in `docs/session-contract.md`.
- Every repository operation takes the verified `userId` explicitly. Never
  use a body, query parameter, GitHub owner, or repo name to choose the D1
  account. See `identity-and-tenant-security` for the full trust boundary.
- Preserve optimistic concurrency: records have server-managed revisions;
  item reads and create/update responses carry strong revision ETags; `PUT`
  and `DELETE` require `If-Match`, with 428 for missing and 412 for stale
  revisions.
- Keep list order stable (date descending, then ID descending), use the opaque
  keyset cursor, and cap page size at 100.
- `/mcp` is stateless and read-only. Its session tools call the same
  `SessionService` as REST and require `sessions:read`; do not introduce a
  second validation or data-access path.
- Treat `/v1` breaking payload, authorization, pagination, or revision changes
  as a versioning change. Do not silently redefine existing `/v1` behavior.

## When changing the contract

1. Update the domain type/validator and application service before adding
   transport-specific behavior.
2. Update `openapi.yaml` and `docs/session-contract.md` in the same change.
   Update `contracts/validation/session-validation-fixtures.json` when
   MatMetrics parity examples or canonical validation outcomes change.
3. If persisted shape or query semantics change, add a forward-only SQL file
   under `migrations/`; do not edit migrations that may already have been
   applied.
4. Extend `test/api.integration.test.ts` for externally visible behavior.
   Keep REST and MCP authorization and account scope consistent.

## Verification commands

For session contract changes, the repo's CI checks are:

```bash
npm test
npm run typecheck
npm run check:migrations
```

`npm run cf-typegen:check` is also part of CI when Worker bindings or
`wrangler.jsonc` change.
