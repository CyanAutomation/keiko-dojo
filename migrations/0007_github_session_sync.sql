-- A GitHub Markdown repository is a derived second-brain copy, not a D1
-- snapshot or restore source. Drop the old application snapshot data.
DROP TABLE IF EXISTS restore_activity;
DROP TABLE IF EXISTS backup_snapshots;
DROP TABLE IF EXISTS backup_jobs;

CREATE TABLE github_session_sync_state (
  user_id TEXT PRIMARY KEY,
  repository_id INTEGER NOT NULL,
  generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
  completed_generation INTEGER NOT NULL DEFAULT 0 CHECK (completed_generation >= 0),
  full_sync_required INTEGER NOT NULL DEFAULT 0 CHECK (full_sync_required IN (0, 1)),
  next_sync_at TEXT NOT NULL,
  wake_enqueued INTEGER NOT NULL DEFAULT 0 CHECK (wake_enqueued IN (0, 1)),
  wake_enqueued_at TEXT,
  dispatch_after TEXT,
  lease_token TEXT,
  lease_expires_at TEXT,
  last_synced_at TEXT,
  last_error TEXT
);

CREATE INDEX github_session_sync_state_dispatch
  ON github_session_sync_state (wake_enqueued, dispatch_after, next_sync_at);

CREATE TABLE github_session_sync_items (
  user_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation > 0),
  PRIMARY KEY (user_id, session_id),
  FOREIGN KEY (user_id) REFERENCES github_session_sync_state(user_id) ON DELETE CASCADE
);

CREATE INDEX github_session_sync_items_user_generation
  ON github_session_sync_items (user_id, generation);

CREATE TABLE github_synced_session_files (
  user_id TEXT NOT NULL,
  repository_id INTEGER NOT NULL,
  session_id TEXT NOT NULL,
  path TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  PRIMARY KEY (user_id, repository_id, session_id),
  UNIQUE (user_id, repository_id, path)
);

CREATE TRIGGER sessions_github_sync_insert
AFTER INSERT ON sessions
BEGIN
  INSERT INTO github_session_sync_state
    (user_id, repository_id, generation, full_sync_required, next_sync_at)
  SELECT NEW.user_id, installation.repository_id, 1, 0,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+60 seconds')
  FROM github_installations AS installation
  WHERE installation.user_id = NEW.user_id AND installation.revoked_at IS NULL
  ON CONFLICT(user_id) DO UPDATE SET
    repository_id = excluded.repository_id,
    generation = github_session_sync_state.generation + 1,
    next_sync_at = excluded.next_sync_at,
    dispatch_after = NULL,
    last_error = NULL;

  INSERT INTO github_session_sync_items (user_id, session_id, generation)
  SELECT NEW.user_id, NEW.id, state.generation
  FROM github_session_sync_state AS state
  WHERE state.user_id = NEW.user_id
  ON CONFLICT(user_id, session_id) DO UPDATE SET generation = excluded.generation;
END;

CREATE TRIGGER sessions_github_sync_update
AFTER UPDATE ON sessions
BEGIN
  INSERT INTO github_session_sync_state
    (user_id, repository_id, generation, full_sync_required, next_sync_at)
  SELECT NEW.user_id, installation.repository_id, 1, 0,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+60 seconds')
  FROM github_installations AS installation
  WHERE installation.user_id = NEW.user_id AND installation.revoked_at IS NULL
  ON CONFLICT(user_id) DO UPDATE SET
    repository_id = excluded.repository_id,
    generation = github_session_sync_state.generation + 1,
    next_sync_at = excluded.next_sync_at,
    dispatch_after = NULL,
    last_error = NULL;

  INSERT INTO github_session_sync_items (user_id, session_id, generation)
  SELECT NEW.user_id, NEW.id, state.generation
  FROM github_session_sync_state AS state
  WHERE state.user_id = NEW.user_id
  ON CONFLICT(user_id, session_id) DO UPDATE SET generation = excluded.generation;
END;

CREATE TRIGGER sessions_github_sync_delete
AFTER DELETE ON sessions
BEGIN
  INSERT INTO github_session_sync_state
    (user_id, repository_id, generation, full_sync_required, next_sync_at)
  SELECT OLD.user_id, installation.repository_id, 1, 0,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+60 seconds')
  FROM github_installations AS installation
  WHERE installation.user_id = OLD.user_id AND installation.revoked_at IS NULL
  ON CONFLICT(user_id) DO UPDATE SET
    repository_id = excluded.repository_id,
    generation = github_session_sync_state.generation + 1,
    next_sync_at = excluded.next_sync_at,
    dispatch_after = NULL,
    last_error = NULL;

  INSERT INTO github_session_sync_items (user_id, session_id, generation)
  SELECT OLD.user_id, OLD.id, state.generation
  FROM github_session_sync_state AS state
  WHERE state.user_id = OLD.user_id
  ON CONFLICT(user_id, session_id) DO UPDATE SET generation = excluded.generation;
END;

-- Reconcile repositories already connected before this sync pipeline existed.
INSERT INTO github_session_sync_state
  (user_id, repository_id, generation, full_sync_required, next_sync_at)
SELECT user_id, repository_id, 1, 1,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+60 seconds')
FROM github_installations
WHERE revoked_at IS NULL
ON CONFLICT(user_id) DO UPDATE SET
  repository_id = excluded.repository_id,
  generation = github_session_sync_state.generation + 1,
  full_sync_required = 1,
  next_sync_at = excluded.next_sync_at,
  wake_enqueued = 0,
  wake_enqueued_at = NULL,
  dispatch_after = NULL,
  lease_token = NULL,
  lease_expires_at = NULL,
  last_synced_at = NULL,
  last_error = NULL;
