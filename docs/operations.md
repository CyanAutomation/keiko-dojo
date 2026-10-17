# Operations and production gates

This first slice is deployable independently, but production routing is not
ready until the identity provider, databases, and recovery controls below are
configured.

## Environment setup

- Create one Keiko-owned D1 database for staging and a separate one for
  production. Replace the placeholder IDs and auth URLs in `wrangler.jsonc`.
- Apply migrations to the target environment before deploying the Worker.
- Keep MatMetrics' `matmetrics-data` database separate. Do not store user
  session data in a browser-visible D1 REST endpoint.
- Keep token signing keys in Better Auth. Keiko needs only its configured,
  public JWKS URL, issuer, and audience.

## Authentication and traffic controls

- Configure Better Auth to issue Keiko-specific tokens with the
  `keiko-dojo-api` audience, the delegated `sessions:read` and/or
  `sessions:write` scope, and a maximum five-minute lifetime.
- Verify that the Keiko JWKS URL is public-key-only and uses HTTPS in staging
  and production. The Worker rejects missing or invalid auth configuration.
- Set per-IP and per-account rate limits at the edge before opening the REST
  API to general clients. The first slice does not choose production limits;
  tune thresholds from expected MatMetrics traffic and the complementary-app
  client model.
- Review Worker logs to confirm request IDs, method, normalized route, status,
  duration, and environment are present, and session payloads and bearer tokens
  are absent.

## Recovery

- Before a schema migration or bulk import, record a D1 recovery point and
  export the database schema and data to protected storage.
- Practice restoring the recovery point into an isolated database before
  relying on it. Do not restore an older snapshot over newer session writes
  without reconciling the affected records.
- Keep GitHub imports, backups, and restores out of ordinary session request
  paths. When those adapters are added, make restore a separate preview and
  confirmation flow with an audit record.

## AI data

This Worker does not call an AI provider. Do not add an AI call until its field
allowlist, purpose, provider retention and training terms, user consent,
logging behavior, and failure handling have been documented and approved for
development, staging, and production.
