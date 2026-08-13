#!/bin/sh
set -eu

base_url=${BEELINE_INSTALL_BASE_URL:-https://relay.buzzrouter.com}
base_url=${base_url%/}
bin_dir=${BEELINE_INSTALL_DIR:-"$HOME/.local/bin"}
lib_dir=${BEELINE_INSTALL_LIB_DIR:-"$(dirname "$bin_dir")/lib/beeline"}

fail() {
  echo "beeline installer: $*" >&2
  exit 1
}

command -v node >/dev/null 2>&1 || fail "Node.js 20.11 or newer is required"
command -v curl >/dev/null 2>&1 || fail "curl is required"
command -v tar >/dev/null 2>&1 || fail "tar is required"

node_version=$(node --version)
node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 20 || (major === 20 && minor >= 11) ? 0 : 1)' || \
  fail "Node.js 20.11 or newer is required (found $node_version)"
echo "beeline installer: Node.js 20.11+ runtime required (found $node_version)"

case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) fail "unsupported operating system: $(uname -s)" ;;
esac

case "$(uname -m)" in
  x86_64|amd64) arch=x64 ;;
  arm64|aarch64) arch=arm64 ;;
  *) fail "unsupported architecture: $(uname -m)" ;;
esac

platform=${BEELINE_INSTALL_PLATFORM:-"$os-$arch"}
case "$platform" in
  linux-x64|darwin-arm64) ;;
  *) fail "no Beeline bundle is available for $platform" ;;
esac

temporary_dir=$(mktemp -d "${TMPDIR:-/tmp}/beeline-install.XXXXXX")
trap 'rm -rf "$temporary_dir"' EXIT HUP INT TERM
archive="$temporary_dir/beeline-$platform.tar.gz"
checksum="$archive.sha256"

echo "beeline installer: downloading $platform bundle"
curl -fsSL "$base_url/dl/beeline-$platform.tar.gz" -o "$archive"
curl -fsSL "$base_url/dl/beeline-$platform.tar.gz.sha256" -o "$checksum"

expected=$(sed -n '1s/[[:space:]].*//p' "$checksum")
if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$archive" | sed 's/[[:space:]].*//')
elif command -v shasum >/dev/null 2>&1; then
  actual=$(shasum -a 256 "$archive" | sed 's/[[:space:]].*//')
else
  fail "sha256sum or shasum is required"
fi
if [ -z "$expected" ] || [ "$actual" != "$expected" ]; then
  fail "bundle checksum mismatch"
fi

tar -tzf "$archive" | while IFS= read -r path; do
  case "$path" in
    /*|../*|*/../*) fail "unsafe path in bundle: $path" ;;
  esac
done
tar -xzf "$archive" -C "$temporary_dir"

for path in bin/beeline bin/buzz-agent bin/buzz-dev-mcp bin/buzz-readonly-mcp lib/beeline/beeline-cli.mjs lib/beeline/beeline-readonly-mcp.mjs; do
  [ -f "$temporary_dir/$path" ] || fail "bundle is missing $path"
done

mkdir -p "$bin_dir" "$lib_dir"
install -m 0644 "$temporary_dir/lib/beeline/beeline-cli.mjs" "$lib_dir/beeline-cli.mjs"
install -m 0644 "$temporary_dir/lib/beeline/beeline-readonly-mcp.mjs" "$lib_dir/beeline-readonly-mcp.mjs"
install -m 0755 "$temporary_dir/bin/beeline" "$bin_dir/beeline"
install -m 0755 "$temporary_dir/bin/buzz-agent" "$bin_dir/buzz-agent"
install -m 0755 "$temporary_dir/bin/buzz-dev-mcp" "$bin_dir/buzz-dev-mcp"
install -m 0755 "$temporary_dir/bin/buzz-readonly-mcp" "$bin_dir/buzz-readonly-mcp"

echo "beeline installer: installed beeline, buzz-agent, buzz-dev-mcp, and buzz-readonly-mcp in $bin_dir"
case ":${PATH:-}:" in
  *:"$bin_dir":*) ;;
  *) echo "beeline installer: add $bin_dir to PATH: export PATH=\"$bin_dir:\$PATH\"" ;;
esac
echo "beeline installer: run: beeline pair <code>"
