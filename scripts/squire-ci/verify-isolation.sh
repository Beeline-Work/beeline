#!/usr/bin/env bash
set -euo pipefail
test "$(id -un)" = beeline-ci
case " $(id -Gn) " in *' sudo '*|*' docker '*) exit 1 ;; esac
for directory in /home/lunchbox /home/beeline-runner /root /opt /var/lib /run/user; do
  test ! -r "$directory"
  test ! -x "$directory"
  echo "Denied directory: $directory"
done
test ! -r /run/docker.sock
test ! -w /run/docker.sock
test ! -w /usr/local/lib/beeline-ci
if sudo -n true 2>/dev/null; then exit 1; fi
test ! -e "$RUNTIME_DIRECTORY/previous-job"
touch "$RUNTIME_DIRECTORY/previous-job"
test ! -e /tmp/previous-job
touch /tmp/previous-job
printf '#!/bin/sh\nexit 0\n' > /tmp/executable-proof
chmod +x /tmp/executable-proof
/tmp/executable-proof
# Exercise the same Chrome install and sandbox used by mobile browser proofs.
export HOME=/tmp/chrome-proof-home
mkdir -p "$HOME"
chrome=/usr/local/lib/beeline-ci/chrome/google-chrome
test ! -w /usr/local/lib/beeline-ci/chrome
printf '<html><body>overflow-browser-pass</body></html>' > /tmp/chrome-proof.html
timeout 30 "$chrome" --headless=new --no-sandbox --disable-gpu --disable-dev-shm-usage --dump-dom file:///tmp/chrome-proof.html > /tmp/chrome-proof-output.html
grep -q overflow-browser-pass /tmp/chrome-proof-output.html
echo 'Browser render, isolation and clean runtime: PASS'
