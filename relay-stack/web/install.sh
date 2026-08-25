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

for path in bin/beeline bin/buzz-agent bin/buzz-dev-mcp bin/buzz-readonly-mcp lib/beeline/beeline-cli.mjs lib/beeline/beeline-readonly-mcp.mjs lib/beeline/squire-mcp-proxy.mjs lib/beeline/bundle.json; do
  [ -f "$temporary_dir/$path" ] || fail "bundle is missing $path"
done

prefix=$(dirname "$bin_dir")
anchor=${BEELINE_INSTALL_LIB_DIR:-"$prefix/lib/beeline"}
releases_root=$(dirname "$anchor")/beeline-releases
mkdir -p "$releases_root"

release_id=$(node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).commit || ""))' "$temporary_dir/lib/beeline/bundle.json" 2>/dev/null || true)
release_id=$(printf %s "$release_id" | tr -c '0-9a-zA-Z._-' '-' | cut -c1-80)
[ -n "$release_id" ] || release_id="manual-$(date +%s)"
# Stage the download beside the releases root (same filesystem) so placing
# it is a plain rename. A collision on the release id is resolved by
# REUSING the existing complete directory — never by piling up
# timestamp-suffixed duplicates (${id}-<epoch>), which older installers
# accumulated on every reinstall.
target=$releases_root/$release_id
staging=$releases_root/.staging.$$.$release_id
rm -rf "$staging"
mkdir -p "$staging"
cp -R "$temporary_dir/bin" "$temporary_dir/lib" "$staging/"
if [ -L "$target" ]; then
  # A release-id-named SYMLINK here is tangle from the old mv-based swap,
  # never legitimate content — replace it with the real directory.
  rm -f "$target"
  mv "$staging" "$target"
elif [ -d "$target" ] && [ -f "$target/lib/beeline/bundle.json" ]; then
  # Same release id already installed completely: idempotent reinstall.
  # Keep the existing directory (a running daemon may be executing from
  # it) and drop the staged copy.
  rm -rf "$staging"
elif [ -e "$target" ]; then
  # Partial/corrupt leftover from an interrupted earlier install: replace it.
  rm -rf "$target"
  mv "$staging" "$target"
else
  mv "$staging" "$target"
fi

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

# Capture where the anchor pointed BEFORE the swap, so the duplicate-prune
# sweep below never touches a release anything was recently live on.
previous_link_target=
if [ -L "$anchor" ]; then
  previous_link_target=$(readlink "$anchor" || true)
fi

# Point the anchor at the new release with a single atomic rename.
#
# This MUST be rename(2), not `mv`: when $anchor is a symlink to a directory
# — which is exactly its contract shape after the first release-shaped
# install — mv treats the destination as a directory and moves the new link
# INSIDE the old release (beeline-releases/<old>/beeline.new.<pid>), leaving
# the active anchor stale so every reinstall keeps running the previous
# bundle. rename(2) replaces the symlink itself without following it; this is
# the same primitive self-update's activateRelease() relies on.
rm -f "$anchor.new.$$"
ln -s "beeline-releases/$(basename "$target")" "$anchor.new.$$"
node -e 'require("fs").renameSync(process.argv[1], process.argv[2])' "$anchor.new.$$" "$anchor"

# Sweep the litter the old mv-based swap left behind: stray anchor-candidate
# symlinks inside release directories and in lib/, plus any symlink directly
# under beeline-releases/ (a real release there is always a DIRECTORY).
find "$releases_root" -maxdepth 1 -type l -exec rm -f {} + 2>/dev/null || true
find "$(dirname "$anchor")" -maxdepth 1 \( -name 'beeline.new.*' -o -name 'beeline.new-*' \) -exec rm -f {} + 2>/dev/null || true
find "$releases_root" -maxdepth 2 \( -name 'beeline.new.*' -o -name 'beeline.new-*' \) -exec rm -f {} + 2>/dev/null || true

# Prune timestamp-suffixed duplicates of a canonical release that older
# installers created on repeated installs of the same bundle. Only a
# <base>-<digits> sibling of an EXISTING <base> directory carrying the SAME
# bundle identity qualifies, and never one the anchor pointed at before or
# points at now — those stay as meaningful rollback copies.
for dup in "$releases_root"/*-[0-9]*; do
  [ -d "$dup" ] || continue
  dup_name=$(basename "$dup")
  [ "$dup_name" != "$(basename "$target")" ] || continue
  base=${dup_name%-*}
  if [ -z "$base" ] || [ ! -d "$releases_root/$base" ]; then
    continue
  fi
  case "$previous_link_target" in
    */"$dup_name"|*/"$dup_name"/*) continue ;;
  esac
  dup_commit=$(node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).commit || ""))' "$releases_root/$base/lib/beeline/bundle.json" 2>/dev/null || true)
  [ -n "$dup_commit" ] || continue
  dup_id_commit=$(node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).commit || ""))' "$dup/lib/beeline/bundle.json" 2>/dev/null || true)
  [ "$dup_commit" = "$dup_id_commit" ] || continue
  rm -rf "$dup"
done

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

active_link=$(readlink "$anchor" || true)
if [ "$active_link" != "beeline-releases/$(basename "$target")" ]; then
  fail "failed to activate release $(basename "$target") (anchor reads: ${active_link:-nothing})"
fi
echo "beeline installer: active release $(basename "$target")"

echo "beeline installer: installed beeline, buzz-agent, buzz-dev-mcp, and buzz-readonly-mcp in $bin_dir"
case ":${PATH:-}:" in
  *:"$bin_dir":*) ;;
  *) echo "beeline installer: add $bin_dir to PATH: export PATH=\"$bin_dir:\$PATH\"" ;;
esac
echo "beeline installer: run: beeline pair <code>"
