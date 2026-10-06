# Shared helpers for tools/standby/*.sh. Sourced, not run.
#
# The live machine is named by the `primary` object in the R2 bucket, holding an epoch like
# server1-20261006T213000Z (host ID + when it took over). The live machine's replicas are written
# under <epoch>/db and <epoch>/files, so a stale machine can never overwrite the live copy. Each
# machine keeps the epoch it is running as in .standby.env next to compose.yaml.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
COMPOSE=(docker compose --profile primary)

# Reads KEY from .env without sourcing it, so values with $, spaces or quotes are safe.
envget() { [ -f .env ] && sed -n "s/^$1=//p" .env | tail -n1 | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/" || true; }

HOST_ID=$(envget HOST_ID)
R2_BUCKET=$(envget R2_BUCKET)
R2_ENDPOINT=$(envget R2_ENDPOINT)
R2_ACCESS_KEY_ID=$(envget R2_ACCESS_KEY_ID)
R2_SECRET_ACCESS_KEY=$(envget R2_SECRET_ACCESS_KEY)
PEER_SSH=$(envget PEER_SSH)
PEER_DIR=$(envget PEER_DIR); PEER_DIR=${PEER_DIR:-Docker/activity-challenge}
HTTP_PORT=$(envget HTTP_PORT); HTTP_PORT=${HTTP_PORT:-3000}

require_config() {
  local missing=()
  for v in HOST_ID R2_BUCKET R2_ENDPOINT R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY; do [ -n "${!v}" ] || missing+=("$v"); done
  [ ${#missing[@]} -eq 0 ] || { echo "Missing from .env: ${missing[*]}" >&2; exit 1; }
}

# r2 METHOD KEY [BODY] - signed request against the bucket. Sets R2_STATUS and R2_BODY.
r2() {
  local out; out=$(mktemp)
  local args=(-sS -o "$out" -w '%{http_code}' --max-time 15 --aws-sigv4 "aws:amz:auto:s3"
    --user "$R2_ACCESS_KEY_ID:$R2_SECRET_ACCESS_KEY" -X "$1")
  if [ $# -ge 3 ]; then args+=(--data-binary "$3" -H 'Content-Type: text/plain'); fi
  R2_STATUS=$(curl "${args[@]}" "${R2_ENDPOINT%/}/$R2_BUCKET/$2" 2>/dev/null) || R2_STATUS=000
  R2_BODY=$(cat "$out"); rm -f "$out"
}

# Prints the current primary epoch. Returns 1 if there is none yet, 2 if R2 couldn't be reached.
get_primary() {
  r2 GET primary
  case "$R2_STATUS" in 200) printf '%s' "$R2_BODY" | tr -d '[:space:]' ;; 404) return 1 ;; *) return 2 ;; esac
}

set_primary() {
  r2 PUT primary "$1"
  [ "$R2_STATUS" = 200 ] || { echo "Couldn't write the primary marker to R2 (HTTP $R2_STATUS)" >&2; exit 1; }
}

local_epoch() { [ -f .standby.env ] && sed -n 's/^STANDBY_EPOCH=//p' .standby.env || true; }

# Stops the stack in an order that loses nothing: tunnel and app first (no new writes), then give
# Litestream a moment to ship the last changes, then the syncers (files-sync copies once more on stop).
stop_stack() {
  "${COMPOSE[@]}" stop tunnel activity-challenge
  sleep 5
  "${COMPOSE[@]}" stop litestream files-sync
}

# Serialises takeover.sh and guard.sh on this machine. `take_lock wait` blocks; plain take_lock fails if held.
take_lock() { exec 9>.standby.lock; if [ "${1:-}" = wait ]; then flock 9; else flock -n 9; fi; }
