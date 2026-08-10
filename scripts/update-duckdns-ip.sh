#!/bin/bash
# ==========================================
# DuckDNS dynamic IP updater (Pi only)
# ==========================================
# Keeps the DuckDNS record pointed at this machine's actual current local IP. Meant to run
# frequently via the tooltracker-duckdns-update.timer systemd unit (see README) so a DHCP
# lease change (no reservation set up yet) gets corrected within minutes instead of silently
# breaking access for everyone until a human notices and runs the curl command by hand.
#
# Always calls the update API unconditionally rather than only when the IP has changed --
# DuckDNS's update endpoint is idempotent (a no-op if the IP already matches), and comparing
# first would just be an extra moving part for no real benefit.
#
# Usage: bash scripts/update-duckdns-ip.sh (reads DUCKDNS_DOMAIN/DUCKDNS_TOKEN from .env)

set -e

cd "$(dirname "$0")/.."
set -a
source .env
set +a

if [ -z "$DUCKDNS_DOMAIN" ] || [ -z "$DUCKDNS_TOKEN" ]; then
    echo "[$(date)] DUCKDNS_DOMAIN/DUCKDNS_TOKEN not set in .env -- skipping." >&2
    exit 1
fi

CURRENT_IP=$(hostname -I | awk '{print $1}')
RESPONSE=$(curl -s "https://www.duckdns.org/update?domains=${DUCKDNS_DOMAIN}&token=${DUCKDNS_TOKEN}&ip=${CURRENT_IP}")

if [ "$RESPONSE" = "OK" ]; then
    echo "[$(date)] DuckDNS updated: ${DUCKDNS_DOMAIN} -> ${CURRENT_IP}"
else
    echo "[$(date)] DuckDNS update FAILED (response: $RESPONSE)" >&2
    exit 1
fi
