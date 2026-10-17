-- Existing snapshots retain a NULL key. New snapshots claim their job ID so
-- overlapping at-least-once queue deliveries can only create one row.
ALTER TABLE backup_snapshots ADD COLUMN job_snapshot_key TEXT;

CREATE UNIQUE INDEX backup_snapshots_job_key
  ON backup_snapshots (job_snapshot_key)
  WHERE job_snapshot_key IS NOT NULL;
