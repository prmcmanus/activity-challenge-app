#!/usr/bin/env bash
# Make THIS machine the live one: stop the other machine, restore the latest database and files
# from R2, claim the primary marker and start the full stack (app, Litestream, file sync, tunnel).
# Used for failover to the standby and for failing back afterwards - it's the same operation.
#
# Usage, from the deployment directory on the machine that should go live:
#   tools/standby/takeover.sh           normal switch-over
#   tools/standby/takeover.sh --force   the other machine can't be reached to stop it; go anyway
#   tools/standby/takeover.sh --init    first-time setup: start replicating this machine's current data
set -euo pipefail
source "$(dirname "$0")/lib.sh"
MODE=${1:-}
case "$MODE" in ''|--force|--init) ;; *) sed -n '2,10p' "$0" >&2; exit 1 ;; esac
require_config
take_lock wait
[ -n "$(envget TUNNEL_TOKEN)" ] || { echo "Missing from .env: TUNNEL_TOKEN" >&2; exit 1; }

EPOCH="$HOST_ID-$(date -u +%Y%m%dT%H%M%SZ)"
set +e; CURRENT=$(get_primary); rc=$?; set -e
[ $rc -eq 2 ] && { echo "Can't reach R2 - check the R2_* settings in .env and the network." >&2; exit 1; }

start() {
  printf 'STANDBY_EPOCH=%s\n' "$EPOCH" > .standby.env
  # App first, so it has switched the database to WAL mode before Litestream opens it.
  "${COMPOSE[@]}" up -d --build activity-challenge
  echo -n "Waiting for the app"
  for _ in $(seq 30); do
    if curl -sf -o /dev/null "http://localhost:$HTTP_PORT/"; then echo " - up."; break; fi
    echo -n .; sleep 1
  done
  "${COMPOSE[@]}" up -d
  echo "This machine ($HOST_ID) is now live, replicating to r2:$R2_BUCKET/$EPOCH/."
}

if [ "$MODE" = --init ]; then
  if [ $rc -eq 0 ] && [ "${CURRENT%-*}" != "$HOST_ID" ]; then
    echo "$CURRENT is already live. Run without --init to take over from it." >&2; exit 1
  fi
  set_primary "$EPOCH"
  start
  exit 0
fi

[ $rc -eq 1 ] && { echo "No primary yet. Run with --init on the machine that has the live data." >&2; exit 1; }
if [ "$CURRENT" = "$(local_epoch)" ]; then
  echo "This machine is already live ($CURRENT). Making sure everything is running."
  "${COMPOSE[@]}" up -d; exit 0
fi
OLD_HOST=${CURRENT%-*}
echo "Taking over from $OLD_HOST (epoch $CURRENT)."

# 1. Stop the old primary so nothing is written there after we copy.
if [ "$OLD_HOST" != "$HOST_ID" ]; then
  if [ -n "$PEER_SSH" ] && ssh -o ConnectTimeout=5 -o BatchMode=yes "$PEER_SSH" "cd $PEER_DIR && tools/standby/stop.sh"; then
    echo "Stopped $OLD_HOST."
  elif [ "$MODE" = --force ]; then
    echo "WARNING: couldn't stop $OLD_HOST. Anything written there after its last sync is lost," >&2
    echo "and its guard will shut it down within a minute of it reaching R2 again." >&2
  else
    echo "Couldn't stop $OLD_HOST over SSH ($PEER_SSH). If it's really down, rerun with --force." >&2; exit 1
  fi
fi

# 2. Claim the marker before restoring, so a returning old primary's guard stops it straight away.
set_primary "$EPOCH"
"${COMPOSE[@]}" stop 2>/dev/null || true

# 3. Put this machine's stale copy aside, then restore the database and files from the old epoch.
"${COMPOSE[@]}" run --rm --no-deps --user 0 --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER \
  --entrypoint sh litestream -c '
  set -e; keep=/data/pre-takeover-$(date -u +%Y%m%dT%H%M%SZ); mkdir -p "$keep"
  for f in /data/activity.sqlite* /data/.activity.sqlite*; do if [ -e "$f" ]; then mv "$f" "$keep/"; fi; done
  chown -R 1000:1000 /data'
"${COMPOSE[@]}" run --rm --no-deps -e STANDBY_EPOCH="$CURRENT" litestream \
  restore -config /etc/litestream.yml -integrity-check quick /data/activity.sqlite
"${COMPOSE[@]}" run --rm --no-deps --entrypoint rclone files-sync copy "r2:$R2_BUCKET/$CURRENT/files" /data

# 4. Go live.
start

# 5. Tidy R2: keep the three most recent epochs (the live one and two to fall back on).
"${COMPOSE[@]}" run --rm --no-deps --entrypoint sh files-sync -c '
  rclone lsf --dirs-only "r2:$R2_BUCKET" | sed "s:/$::" | grep -E -- "-[0-9]{8}T[0-9]{6}Z$" \
    | awk -F- "{print \$NF\" \"\$0}" | sort -r | tail -n +4 | cut -d" " -f2 \
    | while read -r old; do echo "Removing old epoch $old"; rclone purge "r2:$R2_BUCKET/$old"; done' || true
