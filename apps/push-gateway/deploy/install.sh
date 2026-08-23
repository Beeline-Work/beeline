#!/usr/bin/env bash
set -euo pipefail

repo_root=$(git rev-parse --show-toplevel)
install_dir=${BUZZ_PUSH_INSTALL_DIR:-/home/lunchbox/buzzy-push-gateway}
relay_compose_dir=${BUZZ_PROD_RELAY_DIR:-/home/lunchbox/buzz-router-relay-prod}
registry_source=${BUZZ_PUSH_REGISTRY_SOURCE:?set BUZZ_PUSH_REGISTRY_SOURCE}
service_account_source=${BUZZ_PUSH_SA_SOURCE:?set BUZZ_PUSH_SA_SOURCE}
release_id=$(git -C "$repo_root" rev-parse --short=12 HEAD)
release_dir="$install_dir/releases/$release_id"
image=${BUZZY_PUSH_IMAGE:-beeline-push-gateway:local}

if [[ "$install_dir" == /tmp/* || "$install_dir" == *'/.treehouse/'* || "$install_dir" == *'/firstmate2/'* ]]; then
  echo "refusing ephemeral install directory: $install_dir" >&2
  exit 1
fi
if [[ ! -f "$registry_source" || ! -s "$registry_source" ]]; then
  echo "registry source is missing or empty: $registry_source" >&2
  exit 1
fi
if [[ ! -f "$service_account_source" || ! -s "$service_account_source" ]]; then
  echo "service-account source is missing or empty: $service_account_source" >&2
  exit 1
fi

node -e '
  const fs = require("node:fs");
  const parsed = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (parsed.version !== 1 || !Array.isArray(parsed.registrations) || parsed.registrations.length === 0) {
    throw new Error("registry must be a non-empty version-1 registry");
  }
' "$registry_source"

install -d -m 700 "$install_dir" "$install_dir/releases" "$install_dir/secrets" "$install_dir/state"
if [[ ! -d "$release_dir" ]]; then
  install -d -m 755 "$release_dir"
  git -C "$repo_root" archive HEAD | tar -x -C "$release_dir"
fi

ln -sfn "$release_dir" "$install_dir/current"
service_account_target="$install_dir/secrets/fcm-service-account.json"
if [[ "$(readlink -f "$service_account_source")" != "$(readlink -f "$service_account_target")" ]]; then
  install -m 600 "$service_account_source" "$service_account_target"
else
  chmod 600 "$service_account_target"
fi
if [[ ! -e "$install_dir/state/registrations.json" ]]; then
  install -m 600 "$registry_source" "$install_dir/state/registrations.json"
fi

docker build -t "$image" -f "$release_dir/apps/push-gateway/Dockerfile" "$release_dir"

export BUZZY_PUSH_IMAGE="$image"
export BUZZY_PUSH_SA_HOST_FILE="$service_account_target"
export BUZZY_PUSH_STATE_DIR="$install_dir/state"
compose=(docker compose -f "$relay_compose_dir/compose.yml" --project-directory "$relay_compose_dir")
"${compose[@]}" config --quiet
"${compose[@]}" config --services | grep -qx push-gateway

# Only one poller may own the durable delivery ledger. Stop the legacy unit
# immediately before starting the replacement container.
if systemctl --user is-active --quiet buzzy-push-gateway.service \
  || systemctl --user is-enabled --quiet buzzy-push-gateway.service; then
  systemctl --user disable --now buzzy-push-gateway.service
fi
"${compose[@]}" up -d --no-deps push-gateway
# relay-front's nginx config is a read-only single-file bind. Recreate it so
# Docker follows an atomically replaced host file instead of the old inode.
"${compose[@]}" up -d --force-recreate --no-deps relay-front
