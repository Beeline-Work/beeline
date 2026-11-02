#!/usr/bin/env bash
# One-time operator install of the log walk on squire, as the host user.
# Usage: install-host.sh <out-dir>   (the fix loop agent's readable directory)
set -euo pipefail
out="$1"
base="$HOME/.local/share/beeline-log-walk"
checkout="$base/checkout"
if [ ! -d "$checkout/.git" ]; then
  git clone --quiet https://github.com/Beeline-Work/beeline.git "$checkout"
fi
git -C "$checkout" fetch --quiet origin main
git -C "$checkout" checkout --quiet --detach FETCH_HEAD
env="$HOME/.config/beeline-log-walk.env"
mkdir -p "$base/raw" "$base/state" "$(dirname "$env")" "$HOME/.config/systemd/user"
printf 'LOG_WALK_RAW=%s\nLOG_WALK_STATE=%s\nLOG_WALK_OUT=%s\n' "$base/raw" "$base/state" "$out" > "$env"
cp "$checkout"/scripts/log-walk/systemd/* "$HOME/.config/systemd/user/"
systemctl --user daemon-reload
for app in beeline-server beeline-free-agents beeline-voice-livekit; do
  systemctl --user enable --now "beeline-log-collector@$app.service"
done
systemctl --user enable --now beeline-log-walk.timer
