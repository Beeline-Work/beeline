#!/usr/bin/env bash
set -euo pipefail
# The supervisor sends only a short-lived registration token through stdin.
read -r registration_token
# /run is mounted noexec on squire. PrivateTmp gives each unit a fresh,
# executable workspace, removed with the unit, without opening host /tmp.
mkdir -p /tmp/beeline-ci-job
cd /tmp/beeline-ci-job
export HOME=/tmp/beeline-ci-job/home
export RUNNER_TOOL_CACHE=/tmp/beeline-ci-job/toolcache
mkdir -p "$HOME" "$RUNNER_TOOL_CACHE"
tar -xzf /usr/local/lib/beeline-ci/runner.tar.gz
./config.sh --unattended --ephemeral --disableupdate --url https://github.com/Beeline-Work/beeline --token "$registration_token" --name "$1" --labels squire-ci --no-default-labels --work _work
unset registration_token
exec ./run.sh
