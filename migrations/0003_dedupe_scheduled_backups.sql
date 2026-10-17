ALTER TABLE backup_jobs ADD COLUMN schedule_key TEXT;

CREATE UNIQUE INDEX backup_jobs_user_schedule_key
  ON backup_jobs (user_id, schedule_key)
  WHERE schedule_key IS NOT NULL;
