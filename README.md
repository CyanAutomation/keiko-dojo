# Keiko Dojo

Keiko Dojo is the shared API and domain service for MatMetrics and related
training applications. The first implementation provides authenticated,
user-scoped Judo session CRUD on Cloudflare Workers and D1.

## Local development

Requirements: Node.js 24 and npm 11.

```bash
npm ci
npm run cf-typegen
npm run dev
```

Wrangler uses a local D1 database by default. Apply the schema with:

```bash
npm run migrate:local
```

The local Worker reads the public Better Auth JWKS URL, issuer, and Keiko
audience from `wrangler.jsonc`. It only accepts EdDSA tokens whose subject and
`appUserId` match, whose `scope` contains the required Keiko scope, and whose
issued lifetime is at most five minutes. The current MatMetrics token is still
issued for `matmetrics-api` without Keiko scopes; it is intentionally rejected
until the MatMetrics issuer is configured for the Keiko access-token contract.

## Deployments

Wrangler environments `staging` and `production` have separate Worker names
and D1 bindings. Replace their placeholder database IDs and identity-provider
URLs with the resources for each environment before deploying. Apply migrations
to the corresponding remote database before routing clients to that Worker:

```bash
npm run migrate:staging
npm run deploy:staging
npm run migrate:production
npm run deploy:production
```

Do not use MatMetrics' `matmetrics-data` D1 database for Keiko Dojo. D1 session
queries use the Worker's binding API and parameterized statements; the D1
administrative REST API is not part of the runtime.

## API

The versioned REST contract is in [`openapi.yaml`](openapi.yaml). Every session
operation derives its account key from the verified token. Client-supplied
GitHub `owner` and `repo` values do not select or authorize data.

Architecture decisions are recorded in [`docs/decisions/`](docs/decisions/).
