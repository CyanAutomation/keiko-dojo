---
name: identity-and-tenant-security
description: Preserve Keiko's Better Auth token boundary, operation scopes, per-user D1 ownership, rate limits, and safe logs.
tags: [keiko-dojo, security, authentication, authorization, tenancy]
relatedSkills: [session-api-contract, backup-and-restore, cloudflare-operations]
---

# Identity and Tenant Security

Use this skill when changing bearer authentication, operation scopes, user
ownership, rate limits, cross-service authentication, or request logging.

## Read first

- `docs/decisions/0002-identity-and-revocation.md` for the Better Auth and
  MatMetrics-to-Keiko trust boundary.
- `docs/session-contract.md` for the account-scoping and scope requirements.
- `src/auth/bearer-auth.ts`, `src/http/auth-errors.ts`, and the route being
  changed.

## Keiko token requirements

- Verify signatures with the configured JWKS and accept EdDSA only. Require
  the configured issuer and exact `keiko-dojo-api` audience.
- Require a non-empty `sub` equal to `appUserId`, a valid issue/expiry pair,
  no more than five minutes between issuance and expiry, and the required
  scope for the operation.
- Derive the account key from that verified subject. Carry the resulting
  `userId` into every service and D1 read/write. Never authorize from caller
  supplied IDs, `owner`, `repo`, cookie data, or an unverified JWT payload.
- Keep scopes narrow: session reads use `sessions:read`; session writes use
  `sessions:write`; backup reads, writes, and restores use their respective
  `backups:*` scopes. MCP initialization, discovery, and calls are protected
  by `sessions:read`.
- In deployed environments, rate-limit by the verified user ID and operation
  class. Local and test configurations intentionally skip Cloudflare rate
  limit bindings.

## Cross-service boundary

When changing MatMetrics/Auth Worker issuance behavior, preserve the existing
`matmetrics-api` bearer verification before session-cookie exchange. The
server must compare the cookie's Better Auth user ID to the already verified
bearer user ID, enforce the exact configured origin and same-origin fetch
metadata, and send only the cookie to the fixed Auth Worker URL. Reject
redirects. Never expose the short-lived Keiko token to the browser or forward
the MatMetrics bearer token to Keiko.

## Logging and tests

- Do not log bearer tokens, cookies, private keys, installation tokens, or
  session contents. Keep request logs to the request ID, environment, method,
  normalized route, status, duration, and safe error names/codes.
- Extend tests to cover wrong audience/issuer, mismatched subject claims,
  missing or insufficient scopes, tenant isolation, and rate limits when
  changing those boundaries. For the upstream cookie exchange, preserve tests
  for origin checks and mismatched identities in its owning repository.
- Use `test/api.integration.test.ts` and `test/auth-errors.test.ts` for Keiko
  behavior. Use `docs/decisions/0002-identity-and-revocation.md` as the
  review checklist for end-to-end identity changes.

For API or persistence contract changes, also read `session-api-contract`.
For GitHub credentials and backup ownership, also read `backup-and-restore`.
