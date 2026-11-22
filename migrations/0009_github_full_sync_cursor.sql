ALTER TABLE github_session_sync_state
  ADD COLUMN full_sync_cursor INTEGER NOT NULL DEFAULT 0 CHECK (full_sync_cursor >= 0);

ALTER TABLE github_session_sync_state
  ADD COLUMN full_sync_cursor_generation INTEGER;

ALTER TABLE github_session_sync_state
  ADD COLUMN full_sync_delete_cursor TEXT;

ALTER TABLE github_session_sync_state
  ADD COLUMN full_sync_tree_sha TEXT;
