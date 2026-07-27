#!/bin/bash
# ==========================================
# Deploy to Pi (run from the PC, in Git Bash)
# ==========================================
# Pushes local commits to GitHub, then pulls them onto the Pi and restarts the Node service
# so the change actually takes effect. Static files (public/*.html/*.js/*.css) would already
# be live on next page load without any of this -- this script only matters for server.js (or
# anything else that needs the process restarted to pick up).
#
# Usage: ./scripts/deploy-to-pi.sh
# Assumes: commits are already made locally, the Pi is reachable at tooltracker.local, and
# your SSH key is already authorized on the Pi (see README's Raspberry Pi Migration section).

set -e

PI_HOST="tooltracker@tooltracker.local"
PI_DIR="~/ToolTracker_Server"

echo "==> Pushing to GitHub..."
git push origin main

echo "==> Pulling on the Pi and restarting the service..."
ssh "$PI_HOST" "cd $PI_DIR && git pull && sudo systemctl restart tooltracker"

echo "==> Done. The Pi is now running the latest commit."
