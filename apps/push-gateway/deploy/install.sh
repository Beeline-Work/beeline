#!/usr/bin/env bash
set -euo pipefail

repo_root=$(git rev-parse --show-toplevel)
install_dir=${BUZZ_PUSH_INSTALL_DIR:-/home/lunchbox/buzzy-push-gateway}
relay_compose_dir=${BUZZ_PROD_RELAY_DIR:-/home/lunchbox/buzz-router-relay-prod}
registry_source=${BUZZ_PUSH_REGISTRY_SOURCE:?set BUZZ_PUSH_REGISTRY_SOURCE}
service_account_source=${BUZZ_PUSH_SA_SOURCE:?set BUZZ_PUSH_SA_SOURCE}
release_id=$(git -C "$repo_root" rev-parse --short=12 HEAD)
release_dir="$install_dir/releases/$release_id"

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

install -d -m 700 "$install_dir" "$install_dir/bin" "$install_dir/releases" "$install_dir/secrets" "$install_dir/state"
if [[ ! -d "$release_dir" ]]; then
  install -d -m 755 "$release_dir"
  git -C "$repo_root" archive HEAD | tar -x -C "$release_dir"
  npm ci --prefix "$release_dir"
  npm run build -w @beeline/nostr --prefix "$release_dir"
  npm run build -w @beeline/buzz-client --prefix "$release_dir"
  npm run build -w @beeline/push-gateway --prefix "$release_dir"
  npm prune --omit=dev --prefix "$release_dir"
fi

ln -sfn "$release_dir" "$install_dir/current"
ln -sfn "$(readlink -f "$(command -v node)")" "$install_dir/bin/node"
service_account_target="$install_dir/secrets/fcm-service-account.json"
if [[ "$(readlink -f "$service_account_source")" != "$(readlink -f "$service_account_target")" ]]; then
  install -m 600 "$service_account_source" "$service_account_target"
else
  chmod 600 "$service_account_target"
fi
if [[ ! -e "$install_dir/state/registrations.json" ]]; then
  install -m 600 "$registry_source" "$install_dir/state/registrations.json"
fi

install -d -m 700 "$HOME/.config/systemd/user"
install -m 644 "$repo_root/apps/push-gateway/deploy/buzzy-push-gateway.service" "$HOME/.config/systemd/user/buzzy-push-gateway.service"

export BUZZ_PUSH_INSTALL_DIR="$install_dir"
docker compose \
  -f "$relay_compose_dir/compose.yml" \
  -f "$release_dir/apps/push-gateway/deploy/compose.trusted-read.yml" \
  --project-directory "$relay_compose_dir" \
  config --quiet
docker compose \
  -f "$relay_compose_dir/compose.yml" \
  -f "$release_dir/apps/push-gateway/deploy/compose.trusted-read.yml" \
  --project-directory "$relay_compose_dir" \
  up -d trusted-read-relay trusted-read-front
# The Nginx config is a single-file bind. Recreate the front so Docker follows
# the new release symlink instead of retaining the previous inode.
docker compose \
  -f "$relay_compose_dir/compose.yml" \
  -f "$release_dir/apps/push-gateway/deploy/compose.trusted-read.yml" \
  --project-directory "$relay_compose_dir" \
  up -d --force-recreate --no-deps trusted-read-front

systemctl --user daemon-reload
systemctl --user enable buzzy-push-gateway.service
systemctl --user restart buzzy-push-gateway.service
