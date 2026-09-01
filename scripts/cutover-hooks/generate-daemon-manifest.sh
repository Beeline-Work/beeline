#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname -- "$0")/lib.sh"
need DAEMON_EXCHANGE_MANIFEST
require node
[[ -f "$REPO_ROOT/apps/server/dist/auth.js" ]] || die 'build @beeline/server before generating exchanges'
paths=()
while IFS= read -r id; do
  path="$(runtime_path "$id")"
  secure_file "runtime for $id" "$path"
  paths+=("$path")
done < <(agent_ids)
umask 077
node "$HOOK_DIR/generate-daemon-exchanges.mjs" "$DAEMON_EXCHANGE_MANIFEST" "${paths[@]}"
secure_file DAEMON_EXCHANGE_MANIFEST "$DAEMON_EXCHANGE_MANIFEST"
