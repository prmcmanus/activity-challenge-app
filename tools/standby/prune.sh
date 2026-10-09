#!/usr/bin/env bash
# Daily (see install-guard.sh): delete backup copies older than 30 days, as the privacy policy says.
#  - database copies taken before each update, in backups/ next to compose.yaml (and the test
#    instance's, in ../backups);
#  - copies a switch-over set aside on the data volume (/data/pre-takeover-*);
#  - on the live machine, earlier backup sets in R2 (other epochs) - never the live one - and files deleted
#    from the live set more than 30 days ago (kept under <epoch>/deleted/<date>).
# Litestream itself keeps only 7 days of history in the live set.
set -euo pipefail
source "$(dirname "$0")/lib.sh"
for d in backups ../backups; do
  [ -d "$d" ] && find "$d" -maxdepth 1 -type f -mtime +30 -print -delete
done
if [ -n "$("${COMPOSE[@]}" ps -q --status running activity-challenge 2>/dev/null)" ]; then
  "${COMPOSE[@]}" exec -T activity-challenge sh -c 'find /data -maxdepth 1 -type d -name "pre-takeover-*" -mtime +30 -print -exec rm -rf {} +' || true
fi
EPOCH=$(local_epoch)
if [ -n "$EPOCH" ] && [ -n "$("${COMPOSE[@]}" ps -q --status running files-sync 2>/dev/null)" ]; then
  CUTOFF=$(date -u -d '30 days ago' +%Y%m%d%H%M%S)
  "${COMPOSE[@]}" exec -T -e KEEP="$EPOCH" -e CUTOFF="$CUTOFF" files-sync sh -c '
    rclone lsf --dirs-only "r2:$R2_BUCKET" | sed "s:/$::" | grep -E -- "-[0-9]{8}T[0-9]{6}Z$" | while read -r e; do
      [ "$e" = "$KEEP" ] && continue
      ts=$(echo "${e##*-}" | tr -d TZ)
      [ "$ts" -lt "$CUTOFF" ] && { echo "Removing old backup set $e"; rclone purge "r2:$R2_BUCKET/$e"; }
    done
    # Files deleted on the live machine are kept for 30 days in <epoch>/deleted/<date>, then go for good.
    DAY=$(echo "$CUTOFF" | cut -c1-8)
    rclone lsf --dirs-only "r2:$R2_BUCKET/$KEEP/deleted" 2>/dev/null | sed "s:/$::" | grep -E "^[0-9]{8}$" | while read -r d; do
      [ "$d" -lt "$DAY" ] && { echo "Removing files deleted on $d"; rclone purge "r2:$R2_BUCKET/$KEEP/deleted/$d"; }
    done' || true
fi
