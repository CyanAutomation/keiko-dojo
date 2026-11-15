---
name: mcp-contract
description: Maintain Keiko's stateless MCP endpoint, JSON-RPC contract, protocol compatibility, and read-only session tools.
tags: [keiko-dojo, mcp, json-rpc, api, sessions]
relatedSkills: [session-api-contract, identity-and-tenant-security]
---

# MCP Contract

Use this skill when changing `/mcp`, MCP protocol versions, JSON-RPC handling,
tool schemas, authentication, or the data returned by MCP tools.

## Read first

- `src/http/mcp.ts` for protocol handling, version negotiation, tool schemas,
  body limits, origin checks, and error mapping.
- `src/index.ts` for routing and shared service construction.
- `openapi.yaml` and `README.md` for the published API and MCP description.
- `test/api.integration.test.ts` for protocol, tool, authentication, and
  tenant-scoping scenarios.
- `session-api-contract` for session validation, pagination, and analytics
  behavior shared with REST.
- `identity-and-tenant-security` for bearer verification and the trust boundary.

## Protocol and data rules

- Keep `/mcp` stateless: do not retain protocol sessions between requests.
- Preserve the supported JSON-RPC methods and MCP protocol versions unless an
  intentional compatibility change updates the implementation and tests.
- Keep tools read-only and scoped to the authenticated user. Authenticate with
  `sessions:read` and call the existing `SessionService`; do not add a separate
  data-access or session-validation path.
- Keep tool schemas aligned with runtime argument validation. Reject unknown
  methods and invalid arguments with protocol errors or tool errors consistent
  with the existing contract.
- Preserve the request body size limit, same-origin check when an `Origin` is
  supplied, `Cache-Control: no-store`, and protocol response headers.
- Do not expose exception details or session contents in logs or generic error
  responses.

## When changing MCP behavior

1. Update protocol and tool behavior together with the tests in
   `test/api.integration.test.ts`.
2. Update `README.md` and `openapi.yaml` if the public surface, authentication,
   tool list, or documented behavior changes.
3. Keep session semantics and authorization aligned with the corresponding
   `session-api-contract` and `identity-and-tenant-security` guidance.

Run the focused integration tests and the repository CI checks defined in
`.github/workflows/ci.yml` when implementation changes are made.
