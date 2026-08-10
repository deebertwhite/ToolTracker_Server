#!/bin/bash
# ==========================================
# Automated off-Pi database backup (pg_dump -> Google Drive via rclone)
# ==========================================
# Runs pg_dump inside the Postgres container, then uploads the result to Google Drive via
# the "gdrive" rclone remote (one-time setup via `rclone config` -- see README's Backups
# section). This protects against a genuinely different failure mode than moving Postgres's
# data onto the external drive (see BASE_STORAGE_PATH in docker-compose.yml): that protects
# against an SD card failure specifically, but not against the whole Pi (SD card *and*
# external drive together) being lost, stolen, or destroyed. A copy that lives somewhere
# else entirely is the only thing that covers that.
#
# Retention: keeps the most recent $RETENTION_COUNT backups in Drive, deleting older ones,
# so the folder doesn't grow forever.
#
# Meant to run via the tooltracker-backup.timer systemd unit (see README), but safe to run
# by hand any time: bash scripts/backup-to-drive.sh
#
# Pi-only -- unlike the Node scripts in this directory, this has no PC/dev equivalent, since
# local dev data was never meant to be backed up anywhere.

set -e

RETENTION_COUNT=30
DRIVE_FOLDER="gdrive:ToolTracker_Backups"
CONTAINER_NAME="tooltracker_server-db-1"
DATE=$(date +%Y-%m-%d_%H%M%S)
DUMP_NAME="tooltracker_backup_${DATE}.dump"

echo "[$(date)] Dumping database..."
docker exec "$CONTAINER_NAME" pg_dump -U tooladmin -d tooltracker -F c -f "/tmp/$DUMP_NAME"
docker cp "$CONTAINER_NAME:/tmp/$DUMP_NAME" "/tmp/$DUMP_NAME"
docker exec "$CONTAINER_NAME" rm "/tmp/$DUMP_NAME"

echo "[$(date)] Uploading to Google Drive..."
rclone copy "/tmp/$DUMP_NAME" "$DRIVE_FOLDER/"
rm "/tmp/$DUMP_NAME"

echo "[$(date)] Enforcing retention (keeping the $RETENTION_COUNT most recent)..."
# Filenames sort lexicographically in chronological order (the timestamp is the whole name),
# so the oldest are whatever's left after dropping the last $RETENTION_COUNT entries.
rclone lsf "$DRIVE_FOLDER" --files-only | sort | head -n -"$RETENTION_COUNT" | while read -r old_file; do
    echo "  Deleting old backup: $old_file"
    rclone deletefile "$DRIVE_FOLDER/$old_file"
done

echo "[$(date)] Backup complete."
