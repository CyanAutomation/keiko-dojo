# Session contract

The `/v1` session payload preserves the fields and categories in the MatMetrics
Go contract reviewed at commit `0f8fd5d`: `id`, `date`, optional `description`,
`techniques`, `effort`, `category`, optional `notes`, optional `duration`, and
optional `videoUrl`. `openapi.yaml` is the public transport contract. The
MatMetrics validation examples are kept in
[`contracts/validation/session-validation-fixtures.json`](../contracts/validation/session-validation-fixtures.json)
as the starting parity fixture set.

## Validation and normalization

- On create, an absent or `null` ID is generated. IDs are trimmed, at most 100
  characters, and limited to ASCII letters, digits, `_`, and `-`.
- On update, the URL path selects the session. If the body has an ID, it must
  match the path ID. Validation errors retain MatMetrics' established messages.
- `date` must match `YYYY-MM-DD` and be a real calendar date.
- `effort` must be an integer from 1 through 5.
- `category` must be `Technical`, `Randori`, `Shiai`, `Cardio`, or `S&C`.
- `techniques` must be an array of strings. Values are trimmed and deduplicated
  in their original order; empty values fail validation.
- `description` and `notes` are optional strings.
- `duration` is an optional non-negative integer measured in minutes.
- Empty or whitespace-only `videoUrl` values are omitted. Other values must be
  absolute HTTP(S) URLs and cannot point to private or internal network hosts.
- Unknown request fields are ignored. In particular, `owner` and `repo` do not
  affect account selection or authorization.

Validation failures return HTTP 400 with `error.code = "invalid_session"` and
the canonical validation message in `error.message`.

## Revisions

Every stored record has a server-managed integer revision. Single-record reads
and create/update responses include a strong ETag such as `"1"`; list records
include the revision number. `PUT` and `DELETE` require the same revision in
`If-Match`. Missing headers return 428 and stale revisions return 412.
