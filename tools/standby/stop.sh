#!/usr/bin/env bash
# Stop this machine's stack cleanly, letting Litestream and the file sync ship their last changes.
# takeover.sh on the other machine runs this over SSH; it's also safe to run by hand.
set -euo pipefail
source "$(dirname "$0")/lib.sh"
stop_stack
