-- Successful keyed creates are retained indefinitely so a delayed offline
-- retry can never become a new session after a record expires.
CREATE TABLE session_create_idempotency (
  user_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL
    CHECK (length(idempotency_key) BETWEEN 1 AND 128)
    CHECK (idempotency_key NOT GLOB '*[^A-Za-z0-9._~-]*'),
  request_fingerprint TEXT NOT NULL
    CHECK (length(request_fingerprint) = 64)
    CHECK (request_fingerprint NOT GLOB '*[^0-9a-f]*'),
  session_id TEXT NOT NULL,
  result_json TEXT NOT NULL CHECK (json_valid(result_json)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, idempotency_key)
);
