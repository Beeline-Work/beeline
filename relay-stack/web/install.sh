#!/bin/sh
set -eu

fail() { echo "beeline installer: $*" >&2; exit 1; }
base_url=${BEELINE_INSTALL_BASE_URL:-https://usebeeline.app}
base_url=${base_url%/}
command -v node >/dev/null 2>&1 || fail 'Node.js >=20.11 is required'
node -e 'const v=process.versions.node.split(".").map(Number);process.exit(v[0]>20||(v[0]===20&&v[1]>=11)?0:1)' || fail 'Node.js >=20.11 is required'
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
