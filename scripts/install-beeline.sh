#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
tools_root="$repo_root/.beeline-tools"
upstream_root="$tools_root/block-buzz"
target_root="$tools_root/target"
upstream_ref="${BEELINE_BUZZ_REF:-07a3c768d619db31fee3f0590f9433cdd1213e8f}"

for command_name in git node npm; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "install-beeline: required command not found: $command_name" >&2
    exit 1
  fi
done

cd "$repo_root"
npm install
npm run build -w @beeline/nostr
npm run build -w @beeline/api-contract
npm run build -w @beeline/buzz-client
npm run build -w @beeline/gate
npm run build -w @beeline/body

global_prefix="$(npm prefix -g)"
global_bin="$global_prefix/bin"
mkdir -p "$global_bin"

agent_source="${BUZZ_AGENT_BIN:-}"
mcp_source="${BUZZ_DEV_MCP_BIN:-}"
if [[ -z "$agent_source" ]]; then
  agent_source="$(command -v buzz-agent || true)"
fi
if [[ -z "$mcp_source" ]]; then
  mcp_source="$(command -v buzz-dev-mcp || true)"
fi

if [[ -z "$agent_source" || -z "$mcp_source" ]]; then
  if ! command -v cargo >/dev/null 2>&1; then
    echo "install-beeline: cargo is required to build buzz-agent and buzz-dev-mcp" >&2
    exit 1
  fi
  mkdir -p "$tools_root"
  if [[ ! -d "$upstream_root/.git" ]]; then
    git clone --filter=blob:none --no-checkout https://github.com/block/buzz.git "$upstream_root"
  fi
  git -C "$upstream_root" fetch --depth 1 origin "$upstream_ref"
  git -C "$upstream_root" checkout --detach --force FETCH_HEAD
  cargo build \
    --manifest-path "$upstream_root/Cargo.toml" \
    --release \
    --locked \
    --package buzz-agent \
    --package buzz-dev-mcp \
    --target-dir "$target_root"
  agent_source="$target_root/release/buzz-agent"
  mcp_source="$target_root/release/buzz-dev-mcp"
fi

for binary_path in "$agent_source" "$mcp_source"; do
  if [[ ! -x "$binary_path" ]]; then
    echo "install-beeline: executable not found: $binary_path" >&2
    exit 1
  fi
done

if [[ ! "$agent_source" -ef "$global_bin/buzz-agent" ]]; then
  install -m 0755 "$agent_source" "$global_bin/buzz-agent"
fi
if [[ ! "$mcp_source" -ef "$global_bin/buzz-dev-mcp" ]]; then
  install -m 0755 "$mcp_source" "$global_bin/buzz-dev-mcp"
fi

npm link --workspace @beeline/body

for installed_command in beeline buzz-agent buzz-dev-mcp beeline-readonly-mcp; do
  resolved="$(PATH="$global_bin:/usr/bin:/bin" command -v "$installed_command" || true)"
  if [[ -z "$resolved" ]]; then
    echo "install-beeline: $installed_command was installed in $global_bin, which is not on PATH" >&2
    exit 1
  fi
  echo "install-beeline: $installed_command -> $resolved"
done

echo "install-beeline: run 'beeline pair <code>' inside the repository your agent will use"
