#!/usr/bin/env bash
# Daily production log walk on squire (systemd: beeline-log-walk.timer).
# Runs reviewed main-branch code from a dedicated checkout as the host user, so
# no Actions runner needs access to the owner's state directory. Writes
# report.md/report.json where the fix loop's agent reads them as plain files.
# Usage: host-walk.sh <raw-dir> <state-dir> <out-dir>
set -euo pipefail
raw="$1" state="$2" out="$3"
checkout="${LOG_WALK_CHECKOUT:-$HOME/.local/share/beeline-log-walk/checkout}"
if [ ! -d "$checkout/.git" ]; then
  git clone --quiet --no-checkout https://github.com/Beeline-Work/beeline.git "$checkout"
fi
git -C "$checkout" fetch --quiet origin main
git -C "$checkout" checkout --quiet --detach FETCH_HEAD
# Write to a fresh directory, then swap, so the reader never sees a half report.
next="$out.next"
rm -rf "$next"
node "$checkout/scripts/log-walk/walk.mjs" --raw "$raw" --state "$state" --out "$next" --hours 24
git -C "$checkout" rev-parse HEAD > "$next/source-sha"
rm -rf "$out.prev"
[ -d "$out" ] && mv "$out" "$out.prev"
mv "$next" "$out"
