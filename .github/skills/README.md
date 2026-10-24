# Keiko Dojo Skills

These repository skills capture the conventions that matter when changing
Keiko Dojo's API, tenant boundary, backup pipeline, or Cloudflare environments.
Each skill is in its own directory and uses a `SKILL.md` with YAML metadata.

## Skills

| Skill | Use it when |
| --- | --- |
| [session-api-contract](session-api-contract/SKILL.md) | Changing session fields, validation, pagination, revisions, analytics, or API descriptions. |
| [identity-and-tenant-security](identity-and-tenant-security/SKILL.md) | Changing token verification, scopes, account ownership, request limits, or sensitive logging. |
| [backup-and-restore](backup-and-restore/SKILL.md) | Changing snapshots, queued or scheduled backup jobs, GitHub App access, or restore behavior. |
| [cloudflare-operations](cloudflare-operations/SKILL.md) | Changing Worker/D1/Queue configuration, migrations, CI checks, or staging and production procedures. |

## Choosing a skill

- For a public session payload or behavior change, start with
  `session-api-contract`; also use `identity-and-tenant-security` if ownership
  or authorization is involved.
- For backup data flow or recovery behavior, use `backup-and-restore`; use
  `cloudflare-operations` when a change also affects environment bindings or
  migrations.
- For authentication, tenant isolation, or rate limits, use
  `identity-and-tenant-security`.
- For deployment configuration or schema rollout, use `cloudflare-operations`.

These skills complement the API and operational source of truth in
`openapi.yaml`, `docs/session-contract.md`, `docs/operations.md`, and
`docs/decisions/`. Read the relevant source documents when working on those
areas; this index is navigation, not a replacement for them.
