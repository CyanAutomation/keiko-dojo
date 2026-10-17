# ADR 0002: Better Auth access tokens

- Status: accepted as the Keiko API acceptance contract; issuer integration is pending
- Date: 2026-10-17

## Decision

Better Auth remains the identity provider. Keiko accepts only EdDSA JWTs
verified against the configured Better Auth JWKS URL, with the configured
issuer and the Keiko-specific `keiko-dojo-api` audience. Tokens must contain a
non-empty `sub` equal to the stable `appUserId` claim and a space-delimited
`scope` claim. `sessions:read` is required for reads; `sessions:write` is
required for mutations.

Keiko requires `iat` and `exp` and rejects a token lifetime over five minutes.
It does not call the identity provider for session introspection on each
request. The maximum access-token revocation delay is therefore five minutes.
Malformed or unavailable identity configuration fails closed.

## Issuer integration gap

The MatMetrics baseline reviewed for this decision configures Better Auth JWTs
for audience `matmetrics-api` and adds `appUserId`, but it does not define Keiko
scopes or an explicit five-minute lifetime. Keiko will reject those existing
tokens. Before client cutover, MatMetrics must issue a Keiko-specific delegated
token with `sessions:read` and/or `sessions:write`, the Keiko audience, and a
lifetime no longer than five minutes. A token exchange is not part of this
first slice; if added later, it must verify the upstream token and active
Better Auth session before minting a Keiko token.

## Consequences

- A valid signature alone never authorizes access.
- Client-provided user IDs, GitHub owners, and repository names do not affect
  account scope.
- Token issuance and the staging/production JWKS URLs remain deployment
  prerequisites; no token bypass is provided for local development.
