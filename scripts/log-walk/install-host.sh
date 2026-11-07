#!/usr/bin/env bash
# One-time operator install of the raw log collectors on squire, as the host user.
# Usage: install-host.sh
set -euo pipefail
base="$HOME/.local/share/beeline-log-walk"
checkout="$base/checkout"
if [ ! -d "$checkout/.git" ]; then
  git clone --quiet https://github.com/Beeline-Work/beeline.git "$checkout"
fi
git -C "$checkout" fetch --quiet origin main
git -C "$checkout" checkout --quiet --detach FETCH_HEAD
env="$HOME/.config/beeline-log-walk.env"
mkdir -p "$base/raw" "$(dirname "$env")" "$HOME/.config/systemd/user"
# systemd user units start with a minimal PATH; pin the real flyctl binary.
fly_dir="$(dirname "$(readlink -f "$(command -v flyctl)")")"
printf 'PATH=%s:/usr/local/bin:/usr/bin:/bin\nLOG_WALK_RAW=%s\n' \
  "$fly_dir" "$base/raw" > "$env"
cp "$checkout"/scripts/log-walk/systemd/beeline-log-collector@.service "$HOME/.config/systemd/user/"
systemctl --user daemon-reload
for app in beeline-server beeline-free-agents beeline-voice-livekit; do
  systemctl --user enable --now "beeline-log-collector@$app.service"
done
