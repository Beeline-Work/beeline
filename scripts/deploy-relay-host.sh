#!/usr/bin/env bash
# Deploy the production relay host from a checkout of this repository.
#
# This is the deploy path triggered by .github/workflows/deploy-host.yml on
# every push to main, executed by the self-hosted runner ON the production
# host (the host is not reachable from the internet — it serves through a
# Cloudflare tunnel — so CI cannot reach in; the job runs locally instead).
#
# What it deploys (previously three hand-typed steps):
#   1. the WHOLE relay-stack/web/ tree ->
#      /home/lunchbox/buzz-router-relay-prod/relay-front/web/
#      (install.sh, join/, .well-known/, dl/ with BOTH platform bundles and
#      manifest). Whole-tree, never a subset: the stale hand-deployed
#      install.sh bug came from a deploy path that copied some files and not
#      others.
#   2. apps/auth Dockerfile -> beeline-auth:production. The container is
#      recreated once below: by the full stack reconciliation when config
#      changes, otherwise by an auth-only reconciliation.
#   3. the TRACKED production stack config (relay-stack/prod/{compose.yml,
#      nginx.conf}) -> /home/lunchbox/buzz-router-relay-prod/{compose.yml,
#      relay-front/nginx.conf}, followed by `docker compose up -d` for the
#      full stack. Before
#      this existed, production's compose/nginx were hand-maintained on the
#      host and infra merges (e.g. the #340 push gateway) silently landed
#      nowhere.
#
# Deployment discipline:
#   - back up everything replaced before replacing it
#   - verify staged bytes against the checkout BEFORE swapping anything in
#   - verify against the PUBLIC URL after deploying; a green local swap is
#     not proof — only https://usebeeline.app returning the new bytes is
#   - the materializer cutover is one-way: after legacy consumers are retired,
#     any failure stops and prints the exact forward-recovery commands
#   - idempotent: re-running with unchanged content succeeds cheaply
#   - does NOT touch agent daemons or any other compose service
#
# Drills (documented on purpose, used to prove failure behaviour without
# waiting for a real outage):
#   BEELINE_DEPLOY_DRILL=fail-public  corrupt one staged file AFTER the local
#                                     checks so ONLY the public verification
#                                     can catch it — exercises the supervised
#                                     recovery path end-to-end.
#
# Privileges: runs as the runner user. Web-tree writes go through the shared
# `relay-web` group; docker through the `docker` group; the privileged steps
# (which must read lunchbox-owned env files or replace lunchbox-owned config
# files) go through fixed-argument passwordless sudo rules installed on the
# host. The stack rollout (step 3) requires these rules IN ADDITION to the
# original auth-only rule — if they are missing, the deploy fails LOUDLY at
# the placement/up step, never silently:
#
#   beeline-runner ALL=(root) NOPASSWD: /usr/bin/install -o lunchbox -g lunchbox -m 644 /home/beeline-runner/beeline-deploy-stage/compose.yml /home/lunchbox/buzz-router-relay-prod/compose.yml
#   beeline-runner ALL=(root) NOPASSWD: /usr/bin/install -o lunchbox -g lunchbox -m 644 /home/beeline-runner/beeline-deploy-stage/nginx.conf /home/lunchbox/buzz-router-relay-prod/relay-front/nginx.conf
#   beeline-runner ALL=(root) NOPASSWD: /usr/bin/docker compose -p buzz-router-prod --env-file /home/lunchbox/buzz-router-relay-prod/.env -f /home/lunchbox/buzz-router-relay-prod/compose.yml up -d --remove-orphans
#   beeline-runner ALL=(lunchbox) NOPASSWD: /usr/bin/env XDG_RUNTIME_DIR=/run/user/1000 /usr/bin/systemctl --user is-active beeline-events.service
#   beeline-runner ALL=(lunchbox) NOPASSWD: /usr/bin/env XDG_RUNTIME_DIR=/run/user/1000 /usr/bin/systemctl --user is-enabled beeline-events.service
#   beeline-runner ALL=(lunchbox) NOPASSWD: /usr/bin/env XDG_RUNTIME_DIR=/run/user/1000 /usr/bin/systemctl --user disable --now beeline-events.service
#
set -euo pipefail

PROJECT_DIR=${BEELINE_PROD_DIR:-/home/lunchbox/buzz-router-relay-prod}
WEBROOT=$PROJECT_DIR/relay-front/web
BACKUP_ROOT=$PROJECT_DIR/relay-front/web-backups
BACKUP_KEEP=10
PUBLIC_BASE=${BEELINE_PUBLIC_BASE:-https://usebeeline.app}
DRILL=${BEELINE_DEPLOY_DRILL:-}
STACK_STAGE_DIR=${BEELINE_STACK_STAGE_DIR:-/home/beeline-runner/beeline-deploy-stage}
MATERIALIZER_UID=1000
MATERIALIZER_GID=1000

CHECKOUT=$(git rev-parse --show-toplevel)
REPO_WEB=$CHECKOUT/relay-stack/web
REPO_STACK=$CHECKOUT/relay-stack/prod

log() { echo ">> $*"; }
die() { echo "!! $*" >&2; exit "${2:-1}"; }

[ -d "$REPO_WEB" ] || die "no relay-stack/web in checkout ($CHECKOUT)"
[ -d "$WEBROOT" ] || die "webroot missing: $WEBROOT"

events_service_absent() {
  local unit_file
  if systemctl list-unit-files --no-legend --no-pager beeline-events.service 2>/dev/null | grep -q '^beeline-events\.service[[:space:]]' \
    || systemctl --user list-unit-files --no-legend --no-pager beeline-events.service 2>/dev/null | grep -q '^beeline-events\.service[[:space:]]'; then
    return 1
  fi
  for unit_file in \
    "$HOME/.config/systemd/user/beeline-events.service" \
    /home/lunchbox/.config/systemd/user/beeline-events.service \
    /etc/systemd/system/beeline-events.service \
    /etc/systemd/user/beeline-events.service \
    /usr/lib/systemd/system/beeline-events.service \
    /usr/lib/systemd/user/beeline-events.service; do
    [ -e "$unit_file" ] && return 1
  done
  return 0
}

# A sudoers command specification matches both its argv and its Runas user.
# Probe the exact argv we will later execute before creating a stage, building
# an image, replacing a file, or retiring a running consumer. `sudo -l` is a
# read-only policy query, so a missing rule leaves the current production stack
# untouched.
missing_sudo_rules=()
preflight_sudo_rule() {
  local runas=$1
  shift
  if [ "$runas" = root ]; then
    sudo -n -l "$@" >/dev/null 2>&1 && return 0
  elif sudo -n -l -u "$runas" "$@" >/dev/null 2>&1; then
    return 0
  fi
  if [ "$runas" = root ]; then
    missing_sudo_rules+=("beeline-runner ALL=(root) NOPASSWD: $*")
  else
    missing_sudo_rules+=("beeline-runner ALL=($runas) NOPASSWD: $*")
  fi
}

preflight_privileges() {
  log "preflighting every privileged deploy command"
  preflight_sudo_rule root /usr/bin/install -o lunchbox -g lunchbox -m 644 \
    "$STACK_STAGE_DIR/compose.yml" "$PROJECT_DIR/compose.yml"
  preflight_sudo_rule root /usr/bin/install -o lunchbox -g lunchbox -m 644 \
    "$STACK_STAGE_DIR/nginx.conf" "$PROJECT_DIR/relay-front/nginx.conf"
  preflight_sudo_rule root /usr/bin/docker compose -p buzz-router-prod \
    --env-file "$PROJECT_DIR/.env" -f "$PROJECT_DIR/compose.yml" up -d --remove-orphans

  # An absent legacy unit is not touched by this deploy, so do not require
  # stale systemctl grants after the one-way migration has completed.
  if ! events_service_absent; then
    preflight_sudo_rule lunchbox /usr/bin/env XDG_RUNTIME_DIR=/run/user/1000 \
      /usr/bin/systemctl --user is-active beeline-events.service
    preflight_sudo_rule lunchbox /usr/bin/env XDG_RUNTIME_DIR=/run/user/1000 \
      /usr/bin/systemctl --user is-enabled beeline-events.service
    preflight_sudo_rule lunchbox /usr/bin/env XDG_RUNTIME_DIR=/run/user/1000 \
      /usr/bin/systemctl --user disable --now beeline-events.service
  fi

  if [ "${#missing_sudo_rules[@]}" -gt 0 ]; then
    echo "!! deploy preflight failed; install these exact sudoers rule(s) before retrying:" >&2
    for rule in "${missing_sudo_rules[@]}"; do
      echo "!!   $rule" >&2
    done
    die "privilege preflight failed — production has not been changed"
  fi
}

# Docker creates a missing bind source as root. That turns an otherwise valid
# compose convergence into a materializer EACCES crash-loop, so provision and
# validate each writable materializer source before any cutover work begins.
#
# Do NOT test source paths through the deploy user's shell: lunchbox may own a
# correct source with mode 700, which intentionally prevents beeline-runner
# from traversing it even though the materializer's uid 1000 can. Docker owns
# the bind mount and this probe runs inside the just-built materializer image
# as that uid, so it establishes the permission that actually matters.
container_can_write_bind_source() {
  local source=$1
  docker run --rm --user "$MATERIALIZER_UID:$MATERIALIZER_GID" \
    --mount "type=bind,src=$source,dst=/beeline-bind-source" \
    --entrypoint /bin/sh beeline-materializer:production \
    -c 'test -d /beeline-bind-source && test -w /beeline-bind-source' >/dev/null 2>&1
}

container_can_see_bind_source() {
  local source=$1
  docker run --rm --user 0:0 \
    --mount "type=bind,src=$source,dst=/beeline-bind-source" \
    --entrypoint /bin/sh beeline-materializer:production \
    -c 'test -d /beeline-bind-source' >/dev/null 2>&1
}

ensure_materializer_bind_source() {
  local label=$1 source=$2
  if container_can_write_bind_source "$source"; then
    log "verified $label bind-mount source for materializer uid $MATERIALIZER_UID: $source"
    return 0
  fi
  if ! container_can_see_bind_source "$source"; then
    mkdir -p "$source" || die "could not create $label bind-mount source: $source"
    chmod 0755 "$source" || die "could not set mode on $label bind-mount source: $source"
    log "created $label bind-mount source: $source"
  fi

  if ! container_can_write_bind_source "$source"; then
    echo "!! $label bind-mount source is not writable by materializer uid $MATERIALIZER_UID: $source" >&2
    echo "!! run: sudo chown $MATERIALIZER_UID:$MATERIALIZER_GID $source && sudo chmod 755 $source" >&2
    die "$label bind-mount source ownership or mode is wrong — refusing a materializer crash-loop"
  fi
}

# This is deliberately the first operational stage: every privileged command
# is proven while the old consumers are still up. State-source checks run
# after the local materializer image build, but still before any live swap or
# consumer retirement, so their permission probe uses the actual container.
preflight_privileges

TS=$(date +%Y%m%d-%H%M%S)
STAGE=$(mktemp -d /tmp/beeline-deploy-stage.XXXXXX)
CUTOVER_STARTED=0

manual_recovery() {
  cat >&2 <<EOF
!! MANUAL RECOVERY REQUIRED: the one-way materializer cutover did not finish.
!! Keep beeline-events.service stopped and do not restart the retired push-gateway.
!! Continue the new stack forward with these exact commands:
!! sudo -n -u lunchbox /usr/bin/env XDG_RUNTIME_DIR=/run/user/1000 /usr/bin/systemctl --user disable --now beeline-events.service
!! sudo -n /usr/bin/install -o lunchbox -g lunchbox -m 644 $STACK_STAGE_DIR/compose.yml $PROJECT_DIR/compose.yml
!! sudo -n /usr/bin/install -o lunchbox -g lunchbox -m 644 $STACK_STAGE_DIR/nginx.conf $PROJECT_DIR/relay-front/nginx.conf
!! docker ps -q --filter label=com.docker.compose.project=buzz-router-prod --filter label=com.docker.compose.service=push-gateway | xargs -r docker stop
!! docker ps -q --filter label=com.docker.compose.project=buzz-router-prod --filter label=com.docker.compose.service=materializer | xargs -r docker stop
!! test -z "\$(docker ps -q --filter label=com.docker.compose.project=buzz-router-prod --filter label=com.docker.compose.service=push-gateway)"
!! test -z "\$(docker ps -q --filter label=com.docker.compose.project=buzz-router-prod --filter label=com.docker.compose.service=materializer)"
!! sudo -n /usr/bin/docker compose -p buzz-router-prod --env-file $PROJECT_DIR/.env -f $PROJECT_DIR/compose.yml up -d --remove-orphans
!! docker kill -s HUP \$(docker ps -q --filter label=com.docker.compose.project=buzz-router-prod --filter label=com.docker.compose.service=relay-front)
!! Then verify materializer health with:
!! docker ps --filter label=com.docker.compose.project=buzz-router-prod --filter label=com.docker.compose.service=materializer
!! curl -fsS $PUBLIC_BASE/push/health
!! test "\$(curl -sS -o /dev/null -w '%{http_code}' $PUBLIC_BASE/workspaces)" = 401
EOF
}

cleanup_deploy() {
  local status=$?
  trap - EXIT
  if [ "$status" -ne 0 ] && [ "$CUTOVER_STARTED" = 1 ]; then manual_recovery; fi
  rm -rf "$STAGE"
  exit "$status"
}
trap cleanup_deploy EXIT

# ---------------------------------------------------------------------------
# 0. Capture the current web identity for the deployment log.
# ---------------------------------------------------------------------------
OLD_MANIFEST_SHA=$(sha256sum "$WEBROOT/dl/manifest.json" 2>/dev/null | cut -d' ' -f1 || true)
log "live dl manifest sha: ${OLD_MANIFEST_SHA:-none}"

# ---------------------------------------------------------------------------
# 1. Stage the whole web tree + local integrity check.
# ---------------------------------------------------------------------------
log "staging web tree"
mkdir -p "$STAGE/web"
# --no-o/--no-g: the runner user must not try to preserve owner/group across
# users; the live tree's setgid relay-web directories keep the shared group.
rsync -a -O --no-p --no-o --no-g --delete "$REPO_WEB/" "$STAGE/web/"

if ! diff -r --brief "$REPO_WEB" "$STAGE/web" >$STAGE/stage-diff.txt 2>&1; then
  cat $STAGE/stage-diff.txt >&2
  die "staged copy differs from checkout — aborting before anything was touched"
fi

# Every advertised bundle must exist AND its .sha256 sidecar must match.
for f in "$REPO_WEB"/dl/*.tar.gz; do
  b=$(basename "$f")
  want=$(awk '{print $1}' "$REPO_WEB/dl/$b.sha256")
  got=$(sha256sum "$f" | cut -d' ' -f1)
  [ "$want" = "$got" ] || die "bundle $b fails its own .sha256 sidecar"
  log "staged bundle ok: $b ($(wc -c <"$f") bytes)"
done

if [ "$DRILL" = "fail-public" ]; then
  echo "# drill corruption $(date +%s)" >>"$STAGE/web/install.sh"
  log "DRILL fail-public: install.sh corrupted post-local-check (public verify must catch this)"
fi

# ---------------------------------------------------------------------------
# 2. Build the new auth image BEFORE touching anything live, so a build
#    failure costs nothing.
# ---------------------------------------------------------------------------
log "building beeline-auth:production"
docker build -f "$CHECKOUT/apps/auth/Dockerfile" -t beeline-auth:production "$CHECKOUT" \
  >$STAGE/auth-build.log 2>&1 || { tail -40 $STAGE/auth-build.log >&2; die "auth image build failed"; }
tail -3 $STAGE/auth-build.log

# The one materializer image hosts push, repository events, and snapshots.
# Build it BEFORE anything live is touched, so a build failure costs nothing.
log "building beeline-materializer:production"
docker build -f "$CHECKOUT/apps/push-gateway/Dockerfile" -t beeline-materializer:production "$CHECKOUT" \
  >$STAGE/materializer-build.log 2>&1 || { tail -40 $STAGE/materializer-build.log >&2; die "materializer image build failed"; }
tail -3 $STAGE/materializer-build.log

ensure_materializer_bind_source push-state "${BUZZY_PUSH_STATE_DIR:-/home/lunchbox/buzzy-push-gateway/state}"
ensure_materializer_bind_source runtime-state "${BEELINE_RUNTIME_STATE_DIR:-/home/lunchbox/.local/state}"
ensure_materializer_bind_source events-state "${BEELINE_EVENTS_HOST_STATE_DIR:-/home/lunchbox/.local/state/beeline/events}"

# ---------------------------------------------------------------------------
# 3. Back up the current web tree, then swap the staged one in IN PLACE.
#    The directory itself must keep its inode: nginx bind-mounts it into the
#    relay-front container read-only, so an atomic rename would swap the name
#    while the container keeps serving the old mount. rsync per-file renames
#    under the same directory are atomic per file.
# ---------------------------------------------------------------------------
mkdir -p "$BACKUP_ROOT"
BAK=$BACKUP_ROOT/bak-$TS
log "backing up live web tree to $BAK"
rsync -a -O --no-p --no-o --no-g "$WEBROOT/" "$BAK/"

log "swapping staged tree into $WEBROOT"
rsync -a -O --no-p --no-o --no-g --delete "$STAGE/web/" "$WEBROOT/"

# Local post-swap check before spending time on the public round-trips.
diff -r --brief "$STAGE/web" "$WEBROOT" >/dev/null || {
  log "post-swap local mismatch — rolling back web tree"
  rsync -a -O --no-p --no-o --no-g --delete "$BAK/" "$WEBROOT/"
  die "web swap failed locally; previous content restored"
}

# ---------------------------------------------------------------------------
# 4b. Roll out the TRACKED production stack config (compose.yml + nginx.conf).
#     relay-stack/{compose.yml,nginx.conf} are the ISOLATED gate stack
#     (name: buzzy-gate); production is tracked under relay-stack/prod/.
#     The cutover is deliberately ordered and one-way: validate and stage
#     first, retire legacy consumers, install both tracked files, converge the
#     materializer stack, and verify it. Any failure after retirement stops
#     immediately and leaves exact forward-recovery commands in the log.
# ---------------------------------------------------------------------------
LIVE_COMPOSE=$PROJECT_DIR/compose.yml
LIVE_NGINX=$PROJECT_DIR/relay-front/nginx.conf

[ -f "$REPO_STACK/compose.yml" ] || die "no relay-stack/prod/compose.yml in checkout ($CHECKOUT)"
[ -f "$REPO_STACK/nginx.conf" ] || die "no relay-stack/prod/nginx.conf in checkout ($CHECKOUT)"

log "staging production stack config"
mkdir -p "$STAGE/stack"
cp "$REPO_STACK/compose.yml" "$REPO_STACK/nginx.conf" "$STAGE/stack/"
for f in compose.yml nginx.conf; do
  cmp -s "$REPO_STACK/$f" "$STAGE/stack/$f" || die "staged $f differs from checkout — aborting before anything was touched"
done

# Validate WITHOUT touching real secrets — and without letting compose read
# them either: compose resolves env_file paths itself as the INVOKING user,
# and the auth service's env_file entries point at lunchbox-owned secret
# files the runner cannot read (this failed run 32615214417 with "open
# /home/lunchbox/buzzy-auth/oidc.env: permission denied"). So validation runs
# against a TRANSFORMED COPY whose env_file list items are rewritten to the
# throwaway .env; the real compose.yml is only ever parsed by root via sudo.
awk '
  /^[[:space:]]*env_file:/ { print; inlist=1; next }
  inlist && /^[[:space:]]*-[[:space:]]/ {
    match($0, /^[[:space:]]*/)
    print substr($0, RSTART, RLENGTH) "- .env"
    next
  }
  { inlist=0; print }
' "$STAGE/stack/compose.yml" > "$STAGE/stack/compose.validate.yml"
cat > "$STAGE/stack/.env" <<'EOF'
POSTGRES_PASSWORD=stage-dummy
POSTGRES_USER=buzz
POSTGRES_DB=buzz
REDIS_PASSWORD=stage-dummy
BUZZ_S3_ACCESS_KEY=stage-dummy
BUZZ_S3_SECRET_KEY=stage-dummy
EOF
docker compose -f "$STAGE/stack/compose.validate.yml" --env-file "$STAGE/stack/.env" config --quiet \
  || die "staged compose.yml does not parse — aborting before anything was touched"

# nginx -t in a throwaway container; the network aliases satisfy the upstream
# lookups nginx performs while loading the config (relay/auth/materializer).
docker network create beeline-nginx-test >/dev/null 2>&1 || true
if ! docker run --rm --network beeline-nginx-test \
      --network-alias relay --network-alias auth --network-alias materializer \
      -v "$STAGE/stack/nginx.conf:/etc/nginx/nginx.conf:ro" \
      nginx:1.27-alpine nginx -t >/dev/null 2>&1; then
  docker network rm beeline-nginx-test >/dev/null 2>&1 || true
  die "staged nginx.conf fails nginx -t — aborting before anything was touched"
fi
docker network rm beeline-nginx-test >/dev/null 2>&1 || true

# place_stack_file <name> <live-dest>: copy the staged file over the live one
# through the fixed-argument sudo rule because the live files are
# lunchbox-owned and the runner user cannot write them directly.
place_stack_file() {
  sudo -n /usr/bin/install -o lunchbox -g lunchbox -m 644 "$STACK_STAGE_DIR/$1" "$2" \
    || { echo "!! sudo install of $1 failed — is the fixed-argument sudoers rule installed? See the header of scripts/deploy-relay-host.sh" >&2; return 1; }
}

# Plain-docker nginx reload (the runner is in the docker group; no sudo).
# This only delivers current bytes because
# prod compose.yml binds ./relay-front as a DIRECTORY (/etc/beeline-front):
# a single-file bind of nginx.conf pins the inode at container creation, and
# `install` below replaces that inode while the front runs, leaving the HUP
# reload rereading orphaned pre-deploy bytes forever.
reload_relay_front_nginx() {
  local cid
  cid=$(docker ps -q --filter label=com.docker.compose.project=buzz-router-prod --filter label=com.docker.compose.service=relay-front)
  [ -n "$cid" ] || { echo "!! relay-front container not found — cannot reload nginx" >&2; return 1; }
  docker kill -s HUP "$cid" >/dev/null 2>&1 || { echo "!! nginx HUP reload failed" >&2; return 1; }
  log "relay-front nginx reloaded (HUP)"
}

retire_events_service() {
  local active enabled
  if events_service_absent; then
    log "standalone beeline-events.service already absent; skipping retirement"
    return 0
  fi
  active=$(sudo -n -u lunchbox /usr/bin/env XDG_RUNTIME_DIR=/run/user/1000 \
    /usr/bin/systemctl --user is-active beeline-events.service 2>&1) || true
  enabled=$(sudo -n -u lunchbox /usr/bin/env XDG_RUNTIME_DIR=/run/user/1000 \
    /usr/bin/systemctl --user is-enabled beeline-events.service 2>&1) || true
  case "$active:$enabled" in
    *sudo*|*denied*|*password*)
      echo "!! cannot inspect beeline-events.service — install the fixed sudoers rules documented above" >&2
      return 1
      ;;
  esac
  if [ "$active" != "active" ] && [ "$enabled" != "enabled" ]; then return 0; fi
  log "retiring standalone beeline-events.service before materializer convergence"
  sudo -n -u lunchbox /usr/bin/env XDG_RUNTIME_DIR=/run/user/1000 \
    /usr/bin/systemctl --user disable --now beeline-events.service \
    || { echo "!! could not retire beeline-events.service — install the fixed sudoers rules documented above" >&2; return 1; }
}

stop_tail_containers() {
  local service remaining
  for service in push-gateway materializer; do
    docker ps -q \
      --filter label=com.docker.compose.project=buzz-router-prod \
      --filter label=com.docker.compose.service="$service" \
      | xargs -r docker stop >/dev/null \
      || { echo "!! could not stop $service containers" >&2; return 1; }
  done
  for service in push-gateway materializer; do
    remaining=$(docker ps -q \
      --filter label=com.docker.compose.project=buzz-router-prod \
      --filter label=com.docker.compose.service="$service")
    [ -z "$remaining" ] || { echo "!! $service containers remain running" >&2; return 1; }
  done
}

# Wait without changing the fixed sudo command shape. All services with an
# application healthcheck must be healthy, and relay-front (which deliberately
# has no healthcheck) must be running. This closes the gap where `up -d`
# returned while auth still served 502s during run 32684876277.
wait_for_stack_ready() {
  local attempt service expected cid actual all_ready
  for attempt in $(seq 1 36); do
    all_ready=1
    for service in auth materializer relay relay-front; do
      expected=healthy
      [ "$service" = "relay-front" ] && expected=running
      cid=$(docker ps -aq \
        --filter label=com.docker.compose.project=buzz-router-prod \
        --filter label=com.docker.compose.service="$service" | head -1)
      if [ -z "$cid" ]; then
        all_ready=0
        continue
      fi
      actual=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$cid" 2>/dev/null || true)
      [ "$actual" = "$expected" ] || all_ready=0
    done
    if [ "$all_ready" = 1 ]; then
      log "production stack health verified"
      return 0
    fi
    sleep 5
  done
  echo "!! production stack did not become healthy within 180s" >&2
  for service in auth materializer relay relay-front; do
    cid=$(docker ps -aq \
      --filter label=com.docker.compose.project=buzz-router-prod \
      --filter label=com.docker.compose.service="$service" | head -1)
    [ -z "$cid" ] || docker inspect --format "$service: status={{.State.Status}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}" "$cid" >&2 || true
  done
  return 1
}

reconcile_full_stack() {
  local compose_log=$STAGE/stack-up.log
  if ! sudo -n /usr/bin/docker compose -p buzz-router-prod \
      --env-file "$PROJECT_DIR/.env" -f "$LIVE_COMPOSE" up -d --remove-orphans \
      >"$compose_log" 2>&1; then
    tail -20 "$compose_log" >&2
    return 1
  fi
  wait_for_stack_ready
}

mkdir -p "$STACK_STAGE_DIR"
cp "$STAGE/stack/compose.yml" "$STAGE/stack/nginx.conf" "$STACK_STAGE_DIR/"

CUTOVER_STARTED=1
retire_events_service || die "standalone repository-events retirement failed"
place_stack_file compose.yml "$LIVE_COMPOSE" || die "production compose placement failed"
place_stack_file nginx.conf "$LIVE_NGINX" || die "production nginx placement failed"
stop_tail_containers || die "tail consumer retirement failed"
log "applying production stack (docker compose up -d)"
reconcile_full_stack || die "production stack convergence failed"
reload_relay_front_nginx || die "production nginx reload failed"
log "production stack rolled out"

# ---------------------------------------------------------------------------
# 5. PUBLIC verification — the only proof that counts.
# ---------------------------------------------------------------------------
# Public bytes are compared against the CHECKOUT, never against the staged
# copy — proving public==stage would bless any staging-step corruption (the
# exact failure class that produced the stale hand-deployed install.sh).
pub_sha() { curl -fsSL --max-time 120 "$1" | sha256sum | cut -d' ' -f1; }
repo_sha() { sha256sum "$REPO_WEB/$1" | cut -d' ' -f1; }

verify_public() {
  local failures=0

  # install.sh byte-for-byte against the checkout.
  if [ "$(pub_sha "$PUBLIC_BASE/install")" != "$(repo_sha install.sh)" ]; then
    echo "!! public /install does not serve the merged install.sh" >&2; failures=$((failures+1))
  else log "public /install verified"; fi

  # manifest byte-for-byte, plus every advertised bundle present at its real
  # public URL and matching BOTH its .sha256 sidecar and the manifest entry.
  if [ "$(pub_sha "$PUBLIC_BASE/dl/manifest.json")" != "$(repo_sha dl/manifest.json)" ]; then
    echo "!! public /dl/manifest.json does not serve the merged manifest" >&2; failures=$((failures+1))
  else log "public /dl/manifest.json verified"; fi

  node -e '
    const fs=require("fs");
    const m=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
    const out=[];
    for(const [p,b] of Object.entries(m.bundles??{})){
      if(!b.file||!b.sha256) throw new Error(p+" entry incomplete");
      out.push(b.file+"\t"+b.sha256);
    }
    console.log(out.join("\n"));
  ' "$REPO_WEB/dl/manifest.json" > $STAGE/manifest-bundles.txt || die "unreadable manifest"

  while IFS=$'\t' read -r file want; do
    got=$(pub_sha "$PUBLIC_BASE/dl/$file")
    local_want=$(repo_sha "dl/$file")
    if [ "$got" != "$want" ] || [ "$got" != "$local_want" ]; then
      echo "!! public /dl/$file serves ${got:-nothing}, expected $want (checkout: $local_want)" >&2; failures=$((failures+1))
    else log "public bundle verified: $file"; fi
    side=$(curl -fsSL --max-time 60 "$PUBLIC_BASE/dl/$file.sha256" | awk '{print $1}')
    [ "$side" = "$want" ] || { echo "!! public .sha256 sidecar for $file disagrees with manifest" >&2; failures=$((failures+1)); }
  done < $STAGE/manifest-bundles.txt

  # Well-known association documents must still resolve.
  for wk in apple-app-site-association assetlinks.json; do
    code=$(curl -fsS -o /dev/null -w '%{http_code}' --max-time 30 "$PUBLIC_BASE/.well-known/$wk" || true)
    [ "$code" = "200" ] || { echo "!! /.well-known/$wk returned ${code:-error}" >&2; failures=$((failures+1)); }
  done

  # Push and the authenticated indexer must both be reachable through the front.
  local tries_p=0 code_push=""
  while [ $tries_p -lt 12 ]; do
    code_push=$(curl -fsS -o /dev/null -w '%{http_code}' --max-time 15 "$PUBLIC_BASE/push/health" || true)
    [ "$code_push" = "200" ] && break
    tries_p=$((tries_p+1)); sleep 5
  done
  [ "$code_push" = "200" ] || { echo "!! /push/health did not return 200 (last: ${code_push:-error})" >&2; failures=$((failures+1)); }
  log "public /push/health verified"
  code_indexer=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 "$PUBLIC_BASE/workspaces" || true)
  [ "$code_indexer" = "401" ] || { echo "!! /workspaces did not enforce authenticated index reads (last: ${code_indexer:-error})" >&2; failures=$((failures+1)); }
  log "public authenticated indexer verified"

  # Auth service healthy through the front (container may need a moment).
  local tries=0 code_auth=""
  while [ $tries -lt 12 ]; do
    code_auth=$(curl -fsS -o /dev/null -w '%{http_code}' --max-time 15 "$PUBLIC_BASE/auth/capabilities" || true)
    [ "$code_auth" = "200" ] && break
    tries=$((tries+1)); sleep 5
  done
  [ "$code_auth" = "200" ] || { echo "!! /auth/capabilities did not return 200 (last: ${code_auth:-error})" >&2; failures=$((failures+1)); }

  return $failures
}

verify_public || die "public verification failed; materializer ownership remains one-way"

# ---------------------------------------------------------------------------
# 6. Prune old backups.
# ---------------------------------------------------------------------------
# '|| true' keeps an unmatched glob (no backups yet) from tripping
# pipefail+set -e; pruning is housekeeping, never worth failing a deploy.
ls -1dt "$BACKUP_ROOT"/bak-* 2>/dev/null | tail -n +$((BACKUP_KEEP+1)) | while read -r old; do rm -rf "$old"; done || true

log "OK: public origin serves this deploy (checkout $(git -C "$CHECKOUT" rev-parse HEAD))"
log "done."
