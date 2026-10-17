# ADR 0002: Bound Keiko tokens to Better Auth sessions

- Status: accepted and implemented
- Date: 2026-10-17

## Decision

Better Auth remains the identity provider. MatMetrics retains its existing
`matmetrics-api` bearer-token authentication at every session API route. The
Vercel route validates that token first and retains its verified user ID.

For a cutover account, the server requires the exact configured MatMetrics
origin and `Sec-Fetch-Site: same-origin`. It parses exactly one allowlisted
Better Auth session cookie and forwards only that cookie to the fixed,
server-configured Auth Worker URL. It does not forward the full Cookie header,
MatMetrics bearer token, or a client-selected URL. Redirects are errors.

The Auth Worker uses Better Auth's `getSession` to validate the cookie. It
compares the session user ID to the Vercel request's bearer-verified
`expectedUserId` before signing anything. It uses Better Auth's existing
JWKS-managed signer to issue a Keiko-only EdDSA JWT with audience
`keiko-dojo-api`, matching `sub` and `appUserId`, requested allowlisted scopes,
and a lifetime of at most five minutes. Existing MatMetrics JWT defaults and
the regular token endpoint remain unchanged.

Vercel verifies signature, issuer, exact audience, subject, `appUserId`,
expiry, maximum lifetime, and exact requested scopes. It then forwards only
the Keiko JWT to Keiko. It never returns that JWT to the browser. The internal
issuance endpoint is outside `/api/auth/*`, so the existing browser-facing
rewrite does not expose it. No browser headers or sign-in workflows change.

## Security properties

- Missing or invalid MatMetrics bearer tokens fail before session-cookie
  exchange.
- A Better Auth session for a different user is rejected before token
  issuance.
- Cookie-authenticated issuance rejects missing, cross-origin, and cross-site
  requests.
- Cookie parsing rejects missing, duplicate, ambiguous, oversized, or invalid
  session values. Unrelated cookies are never forwarded.
- A Keiko token cannot authorize MatMetrics APIs because the original
  `matmetrics-api` audience remains required there; a MatMetrics token cannot
  authorize Keiko because Keiko requires `keiko-dojo-api`.
- Keiko checks the same stable verified user ID on every session, analytics,
  backup, and MCP operation. D1 ownership comes from the token subject.

## Key management and revocation

Keiko token signing uses the existing Better Auth key lifecycle and public
JWKS; Keiko has no signing secret. A Better Auth session revoked after
issuance can remain usable only until its Keiko token expires, at most five
minutes. GitHub backup uses a separate GitHub App private key because GitHub
requires an App JWT to create short-lived repository installation tokens; the
installation token is repository-scoped and never stored.

## Consequences

- MatMetrics can migrate one account at a time without changing browser auth.
- Until an account is on the server-side allowlist, its existing storage
  behavior remains in place.
- Production rollout requires exact origin configuration, a valid Auth Worker
  URL, matching Keiko issuer/JWKS configuration, and staging isolation checks.
