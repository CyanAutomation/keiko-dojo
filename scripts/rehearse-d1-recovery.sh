#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: $0 production <protected-export.sql> --confirm-export" >&2
  exit 2
}

[[ $# -eq 3 && "$3" == "--confirm-export" ]] || usage

environment="$1"
export_path="$2"
case "$environment" in
  production) database="keiko-dojo" ;;
  *) usage ;;
esac

if [[ -e "$export_path" || -L "$export_path" ]]; then
  echo "Refusing to overwrite an existing export path: $export_path" >&2
  exit 1
fi

export_directory="$(dirname "$export_path")"
mkdir -p -m 700 "$export_directory"
umask 077

rehearsal_directory="$(mktemp -d "${TMPDIR:-/tmp}/keiko-d1-recovery.XXXXXX")"
cleanup() {
  rm -r -- "$rehearsal_directory"
}
trap cleanup EXIT

echo "Exporting $environment D1 to $export_path"
export_log="$rehearsal_directory/export.log"
if npx wrangler d1 export "$database" --remote --env "$environment" \
  --output "$export_path" >"$export_log" 2>&1; then
  sed '/You can also download your export from the following URL manually/d' "$export_log"
else
  export_status=$?
  sed '/You can also download your export from the following URL manually/d' "$export_log" >&2
  exit "$export_status"
fi
chmod 600 "$export_path"

echo "Restoring the SQL export into an isolated local D1 database"
restore_log="$rehearsal_directory/restore.log"
if npx wrangler d1 execute keiko-dojo-local \
  --local \
  --persist-to "$rehearsal_directory/local-state" \
  --file "$export_path" >"$restore_log" 2>&1; then
  echo "Isolated local restore completed successfully"
else
  cat "$restore_log" >&2
  echo "The isolated local restore failed; see the log above for diagnostics" >&2
  exit 1
fi

echo "Checking restored table counts"
npx wrangler d1 execute keiko-dojo-local \
  --local \
  --persist-to "$rehearsal_directory/local-state" \
  --command "SELECT 'sessions' AS table_name, COUNT(*) AS row_count FROM sessions;
SELECT 'backup_jobs' AS table_name, COUNT(*) AS row_count FROM backup_jobs;
SELECT 'backup_snapshots' AS table_name, COUNT(*) AS row_count FROM backup_snapshots;
SELECT 'github_installations' AS table_name, COUNT(*) AS row_count FROM github_installations;
SELECT 'github_installation_states' AS table_name, COUNT(*) AS row_count FROM github_installation_states;
SELECT 'restore_activity' AS table_name, COUNT(*) AS row_count FROM restore_activity;" \
  --json

echo "Recovery rehearsal succeeded. The protected SQL export remains at $export_path"
