CREATE TABLE sessions (
  user_id TEXT NOT NULL,
  id TEXT NOT NULL,
  session_date TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('Technical', 'Randori', 'Shiai', 'Cardio', 'S&C')),
  effort INTEGER NOT NULL CHECK (effort BETWEEN 1 AND 5),
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, id)
);

CREATE INDEX sessions_user_date_id
  ON sessions (user_id, session_date DESC, id DESC);

CREATE INDEX sessions_user_category_date_id
  ON sessions (user_id, category, session_date DESC, id DESC);

CREATE INDEX sessions_user_effort_date_id
  ON sessions (user_id, effort, session_date DESC, id DESC);
