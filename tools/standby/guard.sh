#!/usr/bin/env bash
# Runs every minute from a systemd user timer (see install-guard.sh). Restarts the app if it has stopped
# answering its health check. If R2 says another machine is live, stop this one, so a primary that comes
# back after a failover can't serve or write stale data.
# Does nothing when R2 can't be reached or no machine has claimed primary yet.
set -euo pipefail
source "$(dirname "$0")/lib.sh"
require_config
take_lock || exit 0  # a takeover is in progress
# If the app is running here but has stopped answering its health check (see compose.yaml), restart it.
APP=$("${COMPOSE[@]}" ps -q activity-challenge 2>/dev/null || true)
if [ -n "$APP" ] && [ "$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$APP" 2>/dev/null)" = unhealthy ]; then
  echo "The app isn't answering its health check - restarting it."
  "${COMPOSE[@]}" restart activity-challenge
fi
set +e; CURRENT=$(get_primary); rc=$?; set -e
[ $rc -eq 0 ] || exit 0
[ "$CURRENT" = "$(local_epoch)" ] && exit 0
[ -n "$("${COMPOSE[@]}" ps -q --status running)" ] || exit 0
echo "$CURRENT is live, not this machine ($HOST_ID) - stopping."
stop_stack
rm -f .standby.env
