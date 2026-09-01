#!/usr/bin/env bash
set -euo pipefail

hook_dir="$(cd -- "$(dirname -- "$0")" && pwd -P)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin" "$tmp/old/relay-front" "$tmp/home/.local/state/beeline/agents"
log="$tmp/calls"

cat >"$tmp/bin/systemctl" <<'EOF'
#!/usr/bin/env bash
if [[ "$*" == *'show -p ActiveState --value'* ]]; then echo inactive; exit 0; fi
exit 0
EOF
cat >"$tmp/bin/psql" <<'EOF'
#!/usr/bin/env bash
echo 0
EOF
cat >"$tmp/bin/docker" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$CUTOVER_SELF_TEST_LOG"
exit 0
EOF
chmod +x "$tmp/bin/"*

one="$(printf 'a%.0s' {1..64})"
two="$(printf 'b%.0s' {1..64})"
export PATH="$tmp/bin:$PATH" HOME="$tmp/home" CUTOVER_SELF_TEST_LOG="$log"
export CUTOVER_AGENT_PUBKEYS="$one $two" OLD_DATABASE_URL='postgresql://unused'
export CUTOVER_OLD_STACK_DIR="$tmp/old"

"$hook_dir/production-hook.sh" drain
"$hook_dir/production-hook.sh" drain-verify
"$hook_dir/production-hook.sh" freeze
grep -Fq 'return 503' "$tmp/old/relay-front/cutover-write-freeze.conf"
grep -Fq 'kill -s HUP relay-front' "$log"
printf 'cutover hook local lifecycle harness passed\n'
