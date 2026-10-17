CREATE TABLE github_installations (
  user_id TEXT PRIMARY KEY,
  installation_id INTEGER NOT NULL,
  repository_owner TEXT NOT NULL,
  repository_name TEXT NOT NULL,
  repository_id INTEGER NOT NULL,
  granted_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE TABLE github_installation_states (
  state_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);
CREATE INDEX github_installation_states_expiry ON github_installation_states (expires_at);

CREATE TABLE backup_jobs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  requested_at TEXT NOT NULL,
  completed_at TEXT,
  error_code TEXT
);
CREATE INDEX backup_jobs_user_requested ON backup_jobs (user_id, requested_at DESC);

CREATE TABLE backup_snapshots (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  session_count INTEGER NOT NULL CHECK (session_count >= 0),
  checksum TEXT NOT NULL,
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  FOREIGN KEY (job_id) REFERENCES backup_jobs(id)
);
CREATE INDEX backup_snapshots_user_created ON backup_snapshots (user_id, created_at DESC);

CREATE TABLE restore_activity (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('previewed', 'restored')),
  created_at TEXT NOT NULL,
  preserved_newer_count INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (snapshot_id) REFERENCES backup_snapshots(id)
);
