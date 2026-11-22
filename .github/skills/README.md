# Keiko Dojo Skills

These repository skills capture the conventions that matter when changing
Keiko Dojo's API, tenant boundary, GitHub integration, automation, or Cloudflare
environments.
Each skill is in its own directory and uses a `SKILL.md` with YAML metadata.

## Skills

| Skill | Use it when |
| --- | --- |
| [session-api-contract](session-api-contract/SKILL.md) | Changing session fields, validation, pagination, revisions, analytics, or API descriptions. |
| [identity-and-tenant-security](identity-and-tenant-security/SKILL.md) | Changing token verification, scopes, account ownership, request limits, or sensitive logging. |
| [github-markdown-sync](github-markdown-sync/SKILL.md) | Changing GitHub Markdown sync, repository operations, queue delivery, or GitHub App access. |
| [mcp-contract](mcp-contract/SKILL.md) | Changing the stateless MCP endpoint, JSON-RPC behavior, protocol versions, or tools. |
| [github-actions-workflows](github-actions-workflows/SKILL.md) | Changing GitHub Actions workflows, Dependabot automation, CI gates, or workflow security. |
| [cloudflare-operations](cloudflare-operations/SKILL.md) | Changing Worker/D1/Queue configuration, migrations, CI checks, or staging and production procedures. |

## Choosing a skill

- For a public session payload or behavior change, start with
  `session-api-contract`; also use `identity-and-tenant-security` if ownership
  or authorization is involved.
- For an OpenAPI compatibility change or generated contract update, use
  `session-api-contract` and follow `docs/api-contract-versioning.md`. Add
  `mcp-contract` when MCP protocol behavior or tool schemas also change.
- For GitHub Markdown sync, use `github-markdown-sync`; use
  `cloudflare-operations` when a change also affects environment bindings or
  migrations.
- For queued GitHub health, sync-all, or Log Doctor jobs, use
  `github-markdown-sync`; add `identity-and-tenant-security` when job
  authorization or tenant scoping changes, and `cloudflare-operations` when
  queue bindings, retry behavior, or migrations change.
- For `/mcp` protocol or tool changes, use `mcp-contract`; add
  `session-api-contract` when session fields or behavior change and
  `identity-and-tenant-security` when authentication or authorization changes.
- For GitHub Actions or Dependabot changes, use `github-actions-workflows`;
  add `cloudflare-operations` when a workflow changes Cloudflare deployment or
  migration procedures.
- For authentication, tenant isolation, or rate limits, use
  `identity-and-tenant-security`.
- For deployment configuration or schema rollout, use `cloudflare-operations`.

These skills complement the API and operational source of truth in
`openapi.yaml`, `docs/api-contract-versioning.md`, `docs/session-contract.md`,
`docs/operations.md`, and `docs/decisions/`. Read the relevant source documents
when working on those areas; this index is navigation, not a replacement for
them.
