#!/bin/sh
set -eu

base_url=${BEELINE_INSTALL_BASE_URL:-https://usebeeline.app}
base_url=${base_url%/}
bin_dir=${BEELINE_INSTALL_DIR:-"$HOME/.local/bin"}

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

# The install layout contract lives in apps/body/src/self-update.ts ("THE
# CONTRACT"): <prefix>/lib/beeline is the ACTIVE BUNDLE ANCHOR — a symlink
# into lib/beeline-releases/<id> whose contents are a full bundle
# (bin/<tools> + lib/beeline/*.mjs + bundle.json) — and <prefix>/bin/* are
# stable forwarders that exec <prefix>/lib/beeline/bin/<tool>. The installer
# produces exactly that shape, and converges older layouts onto it.

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

for path in bin/beeline bin/buzz-agent bin/buzz-dev-mcp bin/buzz-readonly-mcp lib/beeline/beeline-cli.mjs lib/beeline/beeline-readonly-mcp.mjs lib/beeline/bundle.json; do
  [ -f "$temporary_dir/$path" ] || fail "bundle is missing $path"
done

prefix=$(dirname "$bin_dir")
anchor=${BEELINE_INSTALL_LIB_DIR:-"$prefix/lib/beeline"}
releases_root=$(dirname "$anchor")/beeline-releases
mkdir -p "$releases_root"

release_id=$(node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).commit || ""))' "$temporary_dir/lib/beeline/bundle.json" 2>/dev/null || true)
release_id=$(printf %s "$release_id" | tr -c '0-9a-zA-Z._-' '-' | cut -c1-80)
[ -n "$release_id" ] || release_id="manual-$(date +%s)"
target=$releases_root/$release_id
if [ -e "$target" ]; then
  target="$releases_root/${release_id}-$(date +%s)"
fi
mkdir -p "$target"
cp -R "$temporary_dir/bin" "$temporary_dir/lib" "$target/"

# Converge an existing non-release install: a REAL directory at the anchor is
# legacy (installer v1 output, flat or release-shaped). Preserve it as a
# release so rollback language stays meaningful, normalizing flat bundles by
# moving their root-level files down into lib/beeline/. A symlink anchor just
# gets repointed; any stale top-level files a v1 repair reinstall once copied
# THROUGH the old symlink are abandoned with their release, not propagated.
if [ -d "$anchor" ] && [ ! -L "$anchor" ]; then
  legacy_id=$(node -e 'const b=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String(b.commit||b.version||""))' "$anchor/lib/beeline/bundle.json" 2>/dev/null \
    || node -e 'const b=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String(b.commit||b.version||""))' "$anchor/bundle.json" 2>/dev/null || true)
  legacy_id=$(printf %s "$legacy_id" | tr -c '0-9a-zA-Z._-' '-' | cut -c1-80)
  [ -n "$legacy_id" ] || legacy_id="legacy-$(date +%s)"
  legacy_target=$releases_root/$legacy_id
  if [ -e "$legacy_target" ]; then
    legacy_target="$releases_root/${legacy_id}-$(date +%s)"
  fi
  mv "$anchor" "$legacy_target"
  for f in beeline-cli.mjs beeline-readonly-mcp.mjs bundle.json; do
    if [ -f "$legacy_target/$f" ] && [ ! -e "$legacy_target/lib/beeline/$f" ]; then
      mkdir -p "$legacy_target/lib/beeline"
      mv "$legacy_target/$f" "$legacy_target/lib/beeline/$f"
    fi
  done
fi

# Point the anchor at the new release with a single atomic rename.
rm -f "$anchor.new.$$"
ln -s "beeline-releases/$(basename "$target")" "$anchor.new.$$"
mv "$anchor.new.$$" "$anchor"

mkdir -p "$bin_dir"

# Stable forwarders into the ACTIVE bundle root — identical across releases,
# so rewriting them on every install is idempotent hygiene, not churn. They
# exec THROUGH the anchor (<prefix>/lib/beeline/bin/<tool>) and export
# BEELINE_LIB_DIR as the clean anchor path so the bundle wrapper never hands
# node a '..' through the symlink. Keep byte-identical with
# apps/body/src/self-update.ts's forwarderScript().
for tool in buzz-agent buzz-dev-mcp buzz-readonly-mcp; do
  cat > "$bin_dir/.$tool.new.$$" <<EOF
#!/bin/sh
set -eu
case \$0 in
  /*) script_path=\$0 ;;
  *) script_path=\$(pwd -P)/\$0 ;;
esac
prefix_dir=\$(CDPATH= cd -- "\$(dirname -- "\$script_path")/.." && pwd -P)
export BEELINE_LIB_DIR="\$prefix_dir/lib/beeline"
exec "\$prefix_dir/lib/beeline/bin/$tool" "\$@"
EOF
  chmod 0755 "$bin_dir/.$tool.new.$$"
  mv -f "$bin_dir/.$tool.new.$$" "$bin_dir/$tool"
done
cat > "$bin_dir/.beeline.new.$$" <<EOF
#!/bin/sh
set -eu
case \$0 in
  /*) script_path=\$0 ;;
  *) script_path=\$(pwd -P)/\$0 ;;
esac
prefix_dir=\$(CDPATH= cd -- "\$(dirname -- "\$script_path")/.." && pwd -P)
export BEELINE_LIB_DIR="\$prefix_dir/lib/beeline"
: "\${BUZZ_AGENT_BIN:=\$prefix_dir/lib/beeline/bin/buzz-agent}"
: "\${BUZZ_DEV_MCP_BIN:=\$prefix_dir/lib/beeline/bin/buzz-dev-mcp}"
: "\${BUZZ_READONLY_MCP_BIN:=\$prefix_dir/lib/beeline/bin/buzz-readonly-mcp}"
export BUZZ_AGENT_BIN BUZZ_DEV_MCP_BIN BUZZ_READONLY_MCP_BIN
exec "\$prefix_dir/lib/beeline/bin/beeline" "\$@"
EOF
chmod 0755 "$bin_dir/.beeline.new.$$"
mv -f "$bin_dir/.beeline.new.$$" "$bin_dir/beeline"

echo "beeline installer: installed beeline, buzz-agent, buzz-dev-mcp, and buzz-readonly-mcp in $bin_dir"
case ":${PATH:-}:" in
  *:"$bin_dir":*) ;;
  *) echo "beeline installer: add $bin_dir to PATH: export PATH=\"$bin_dir:\$PATH\"" ;;
esac
echo "beeline installer: run: beeline pair <code>"
