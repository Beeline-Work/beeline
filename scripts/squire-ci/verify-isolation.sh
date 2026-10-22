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
echo 'Isolation and clean runtime: PASS'
