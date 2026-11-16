# Keiko API Contract Versioning

## Ownership and source

`openapi.yaml` at the root of Keiko Dojo is the canonical contract for the REST API. The `/v1` paths remain stable and authoritative for session, analytics, backup, and GitHub operation APIs. Handler behavior and contract tests are the evidence for the wire contract; generated TypeScript is a derived artifact.

MatMetrics and future first-party clients pin a Keiko Git commit that contains the reviewed contract. Consumers must not generate from `main`, a branch name, or a mutable download URL. A Keiko application release does not require a new contract version when the contract is unchanged.

## Compatibility rules

Compatible changes may be released on the existing `/v1` paths when they preserve existing callers' behavior. Examples include adding an optional response property, adding an optional query parameter with a safe default, or adding a new endpoint. Clients must ignore unknown response properties and must not assume enum sets are closed when displaying data.

Potentially breaking changes require consumer review and compatibility testing before release. Examples include adding a required request property, tightening validation, changing pagination or error metadata, adding an enum value where consumers exhaustively branch, or changing authentication scopes. Treat all enum additions as potentially breaking unless every supported consumer is known to tolerate them.

Explicitly breaking changes include removing or renaming an endpoint or property, changing a response shape or field type, changing required fields, changing pagination ordering/cursor meaning, changing authentication or tenant semantics, and changing ETag/revision or conditional-write behavior. Introduce an explicitly versioned API path for these changes; do not silently reinterpret `/v1`.

`info.version` is the semantic contract revision, independent of the `/v1`
route prefix and Keiko Worker release number. Use a patch increment for
clarifications that do not change generated wire types, a minor increment for
compatible additions, and a major increment only with a coordinated new API
path for breaking behavior. Commit SHA remains the immutable consumer pin.

The numeric session `revision` and user-scoped ETag are server-owned concurrency metadata. Mutations require the observed `If-Match`; missing preconditions return 428 and stale revisions return 412. Legacy quoted numeric revisions remain accepted. Never infer a new revision after a rejected mutation.

## Validation and generation

Run these commands with the Node and npm versions declared by the repository:

```sh
npm run contract:lint
npm run contract:generate
npm run contract:check
```

The lint uses Redocly to validate OpenAPI syntax, references, and supported structures. CI also diffs the proposed contract against `main`, fails on major changes, and checks that `info.version` matches the required semantic bump. `contract:generate` uses a pinned `openapi-typescript` and TypeScript version to create `contracts/keiko-api.generated.ts`. Do not edit that generated file by hand. CI regenerates it and fails if the committed artifact changes.

## Release and consumer upgrade

1. Update `openapi.yaml` and relevant handler/contract tests together.
2. Run contract lint, generation, typecheck, and the full Keiko test suite.
3. Review whether the change is compatible under the rules above. For potentially breaking or explicit changes, coordinate all supported consumers and use a new versioned path where required.
4. Merge the Keiko contract change and record its immutable Git commit SHA. A tag may be added for human-friendly release notes, but consumer pinning uses the commit SHA.
5. In each consumer PR, update the pinned SHA, regenerate types, review generated diffs, and run integration tests against that revision.
6. Merge/deploy only after consumer compatibility and rollout ordering are agreed. Publishing a tag or deploying Keiko is a separate release action.

## Contract inventory from Phase 2A audit

| API area | Audit result |
| --- | --- |
| `/v1/sessions`, `/v1/sessions/{id}` | Paths, filters, canonical session data, numeric revisions, ETags, conditional reads/writes, and the implemented 400/404/409/412/413/415/428/429 responses were covered. Cursor limits and opaque `nextCursor`/`hasMore` semantics are now explicit. |
| `/v1/analytics/summary`, `/v1/backups/status` | Success schemas and required scopes were covered. Authentication, rate-limit, service-unavailable, and default error responses are now explicit. |
| `/v1/backups/github-installation` | The GET connection schema and POST installation URL schema were missing and are now defined. Invalid/oversized body and service failure responses are documented. |
| `/v1/backups/github-installation/callback` | The unauthenticated, one-time state callback and generic redirect behavior were covered. The required `Location` response header is now explicit. Redirect results intentionally do not expose account identifiers or installation tokens. |
| `/v1/github/health`, `/v1/github/sync-all`, `/v1/github/log-doctor`, `/v1/github/log-doctor/fix` | Accepted bodies, queued job schemas, scopes, and core error statuses were covered. The 409 error envelopes, oversized-body responses, service failures, and default error responses were incomplete and are now described. A missing GitHub connection currently uses HTTP 409 with error code `not_found`; this wire behavior is preserved. |
| `/v1/github/jobs/{jobId}`, `/mcp` | Success schemas/responses, subject scoping, and scopes were covered. Service-unavailable and default error responses are now explicit. |

Every response is assigned an `X-Request-Id` by the Worker wrapper; JSON error envelopes repeat it as `requestId`. Error envelopes carry a safe code and message, and rate limiting includes `Retry-After`. The default response covers other error statuses, including method and route errors.

Backup callback redirects intentionally return a generic success/failure result to the configured MatMetrics origin. They do not expose account identifiers or installation tokens. Authentication scopes and subject-derived user scoping are described at each protected operation and in the API-level security description.
