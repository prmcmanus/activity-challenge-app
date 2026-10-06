#!/usr/bin/env bash
# Install guard.sh as a systemd user timer that runs every minute, including after a reboot.
# Run once on each machine, from the deployment directory: tools/standby/install-guard.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
DIR=$(pwd)
UNITS=~/.config/systemd/user
mkdir -p "$UNITS"
cat > "$UNITS/activetogether-guard.service" <<EOF
[Unit]
Description=Stop Active Together here if another machine is live

[Service]
Type=oneshot
ExecStart=$DIR/tools/standby/guard.sh
EOF
cat > "$UNITS/activetogether-guard.timer" <<EOF
[Unit]
Description=Check every minute which machine is live for Active Together

[Timer]
OnBootSec=30s
OnUnitActiveSec=60s

[Install]
WantedBy=timers.target
EOF
systemctl --user daemon-reload
systemctl --user enable --now activetogether-guard.timer
[ "$(loginctl show-user "$USER" -p Linger --value)" = yes ] || echo "Note: run 'loginctl enable-linger $USER' so the timer runs without you logged in."
echo "Guard installed. Logs: journalctl --user -u activetogether-guard"
