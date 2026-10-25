CREATE TABLE github_operation_jobs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('github-health', 'log-doctor-scan', 'log-doctor-fix', 'github-sync-all')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  result TEXT CHECK (result IS NULL OR json_valid(result)),
  error_message TEXT,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX github_operation_jobs_user_created
  ON github_operation_jobs (user_id, created_at DESC);
