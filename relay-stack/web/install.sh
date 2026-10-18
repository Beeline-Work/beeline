#!/bin/sh
set -eu

fail() { echo "beeline installer: $*" >&2; exit 1; }
base_url=${BEELINE_INSTALL_BASE_URL:-https://usebeeline.app}
base_url=${base_url%/}
# BEGIN GENERATED HELPER NODE (update-helper-toolchain.mjs)
case "$(uname -s)" in Linux) node_os=linux ;; Darwin) node_os=darwin ;; *) fail 'unsupported OS' ;; esac
case "$(uname -m)" in x86_64|amd64) node_arch=x64 ;; arm64|aarch64) node_arch=arm64 ;; *) fail 'unsupported architecture' ;; esac
case "$node_os-$node_arch" in
  linux-x64) node_url='https://nodejs.org/dist/v24.13.0/node-v24.13.0-linux-x64.tar.gz'; node_sha='6223aad1a81f9d1e7b682c59d12e2de233f7b4c37475cd40d1c89c42b737ffa8'; node_generation='node-24.13.0-ca376557e1390726' ;;
  linux-arm64) node_url='https://nodejs.org/dist/v24.13.0/node-v24.13.0-linux-arm64.tar.gz'; node_sha='0f6d40b94c6a2eb6b4c240ffc8b9fd3ada7ab044c177dd413c06e1ef9a63f081'; node_generation='node-24.13.0-e1fd274164eb62fb' ;;
  darwin-x64) node_url='https://nodejs.org/dist/v24.13.0/node-v24.13.0-darwin-x64.tar.gz'; node_sha='6f03c1b48ddbe1b129a6f8038be08e0899f05f17185b4d3e4350180ab669a7f3'; node_generation='node-24.13.0-dae9ce3ec43ee0d8' ;;
  darwin-arm64) node_url='https://nodejs.org/dist/v24.13.0/node-v24.13.0-darwin-arm64.tar.gz'; node_sha='d595961e563fcae057d4a0fb992f175a54d97fcc4a14dc2d474d92ddeea3b9f8'; node_generation='node-24.13.0-4c9243587508fa88' ;;
esac
node_root="${XDG_DATA_HOME:-$HOME/.local/share}/beeline/toolchain"
node_target="$node_root/$node_generation"
if [ ! -f "$node_target/.complete" ]; then
  mkdir -p "$node_root"
  node_stage=$(mktemp -d "$node_root/.staging-node.XXXXXX")
  trap 'rm -rf "$node_stage"' EXIT HUP INT TERM
  curl --retry 3 --retry-delay 1 --connect-timeout 15 --max-time 180 -fsSL "$node_url" -o "$node_stage/node.tar.gz" || fail 'Node 24.13.0 download failed; retry installation'
  if command -v sha256sum >/dev/null 2>&1; then
    node_actual=$(sha256sum "$node_stage/node.tar.gz" | cut -d ' ' -f 1)
  else
    node_actual=$(shasum -a 256 "$node_stage/node.tar.gz" | cut -d ' ' -f 1)
  fi
  [ "$node_actual" = "$node_sha" ] || fail 'Node 24.13.0 SHA-256 checksum mismatch; retry installation'
  tar -xzf "$node_stage/node.tar.gz" -C "$node_stage" --strip-components=1
  rm "$node_stage/node.tar.gz"
  "$node_stage/bin/node" --version >/dev/null || fail 'Node 24.13.0 cannot run on this computer'
  printf '1\n' > "$node_stage/.complete"
  "$node_stage/bin/node" -e 'const f=require("node:fs"),p=require("node:path"),[s,t]=process.argv.slice(1);if(f.existsSync(t)&&!f.existsSync(p.join(t,".complete")))f.rmSync(t,{recursive:true,force:true});try{f.renameSync(s,t)}catch(e){if(f.existsSync(p.join(t,".complete")))f.rmSync(s,{recursive:true,force:true});else throw e}' "$node_stage" "$node_target"
  trap - EXIT HUP INT TERM
fi
PATH="$node_target/bin:$PATH"
export PATH
# END GENERATED HELPER NODE
installer_tmp=$(mktemp -d "${TMPDIR:-/tmp}/beeline-install.XXXXXX")
trap 'rm -rf "$installer_tmp"' EXIT HUP INT TERM
curl --connect-timeout 15 --max-time 60 -fsSL "$base_url/dl/beeline-bootstrap.mjs" -o "$installer_tmp/bootstrap.mjs"
curl --connect-timeout 15 --max-time 60 -fsSL "$base_url/dl/beeline-bootstrap.mjs.sha256" -o "$installer_tmp/bootstrap.sha256"
expected=$(sed -n '1s/[[:space:]].*//p' "$installer_tmp/bootstrap.sha256")
actual=$(node -e 'process.stdout.write(require("crypto").createHash("sha256").update(require("fs").readFileSync(process.argv[1])).digest("hex"))' "$installer_tmp/bootstrap.mjs")
if [ -z "$expected" ] || [ "$actual" != "$expected" ]; then fail 'recovery bootstrap checksum mismatch'; fi
# The independent recovery entry is the same installer used by npx and the installed CLI.
installer_operation=update
if [ "${BEELINE_LAB:-}" = 1 ]; then installer_operation=install-only; fi
node "$installer_tmp/bootstrap.mjs" "$installer_operation" --manifest-url "$base_url/dl/manifest.json"
