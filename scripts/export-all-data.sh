#!/bin/bash
# ==========================================
# Full data export (database + logs + uploaded photos/certs)
# ==========================================
# Bundles everything needed to fully reconstitute this deployment into one timestamped
# .tar.gz: a fresh pg_dump, the logs/ directory (hourly/daily snapshots), and the uploads/
# directory (tool photos, calibration certificates, barcode images). Distinct from
# backup-to-drive.sh, which only ships the database to Google Drive on a timer -- this is a
# full, on-demand copy, meant for James's own second-USB-drive workflow or the admin panel's
# "Download All Data" button (see GET /api/admin/export-all in server.js, which shells out to
# this exact script so there's only one definition of "the full export" to keep in sync).
#
# Usage:
#   bash scripts/export-all-data.sh [destination_dir]
# With a destination_dir (e.g. a second drive's mount point, once it's plugged in and
# mounted), the finished .tar.gz is copied there and the /tmp copy is cleaned up. Without one,
# it's left in /tmp for the caller (the admin endpoint) to pick up and serve, then delete.
#
# The LAST line printed to stdout on success is always the final archive's full path, and
# nothing else -- GET /api/admin/export-all parses exactly that line to find the file; don't
# add further echo statements after it.

set -e
cd "$(dirname "$0")/.."
set -a
source .env 2>/dev/null || true
set +a

BASE_STORAGE_PATH="${BASE_STORAGE_PATH:-$(pwd)}"
CONTAINER_NAME="tooltracker_server-db-1"
DATE=$(date +%Y-%m-%d_%H%M%S)
WORK_DIR=$(mktemp -d)
ARCHIVE_NAME="tooltracker-export-${DATE}.tar.gz"
OUTPUT_PATH="/tmp/${ARCHIVE_NAME}"
trap 'rm -rf "$WORK_DIR"' EXIT

echo "[$(date)] Dumping database..." >&2
docker exec "$CONTAINER_NAME" pg_dump -U tooladmin -d tooltracker -F c -f "/tmp/export_db.dump"
docker cp "$CONTAINER_NAME:/tmp/export_db.dump" "$WORK_DIR/database.dump"
docker exec "$CONTAINER_NAME" rm -f "/tmp/export_db.dump"

echo "[$(date)] Bundling database + logs + uploads..." >&2
tar -czf "$OUTPUT_PATH" \
    -C "$WORK_DIR" database.dump \
    -C "$BASE_STORAGE_PATH" logs \
    -C "$BASE_STORAGE_PATH/public" uploads

if [ -n "$1" ]; then
    if [ ! -d "$1" ]; then
        echo "[$(date)] Destination '$1' is not a directory." >&2
        exit 1
    fi
    echo "[$(date)] Copying to $1 ..." >&2
    cp "$OUTPUT_PATH" "$1/$ARCHIVE_NAME"
    rm "$OUTPUT_PATH"
    echo "$1/$ARCHIVE_NAME"
else
    echo "$OUTPUT_PATH"
fi
