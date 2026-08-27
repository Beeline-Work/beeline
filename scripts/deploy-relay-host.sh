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
#      full stack when (and only when) the config actually changed. Before
#      this existed, production's compose/nginx were hand-maintained on the
#      host and infra merges (e.g. the #340 push gateway) silently landed
#      nowhere.
#
# Deployment discipline:
#   - back up everything replaced before replacing it
#   - verify staged bytes against the checkout BEFORE swapping anything in
#   - verify against the PUBLIC URL after deploying; a green local swap is
#     not proof — only https://usebeeline.app returning the new bytes is
#   - on any post-swap verification failure: roll back to the backup,
#     re-verify publicly, and fail — previously-working content stays served,
#     never a half-swapped directory
#   - idempotent: re-running with unchanged content succeeds cheaply
#   - does NOT touch agent daemons or any other compose service
#
# Drills (documented on purpose, used to prove failure behaviour without
# waiting for a real outage):
#   BEELINE_DEPLOY_DRILL=fail-public  corrupt one staged file AFTER the local
#                                     checks so ONLY the public verification
#                                     can catch it — exercises the rollback
#                                     path end-to-end.
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
#   beeline-runner ALL=(root) NOPASSWD: /usr/bin/docker compose -p buzz-router-prod --env-file /home/lunchbox/buzz-router-relay-prod/.env -f /home/lunchbox/buzz-router-relay-prod/compose.yml up -d
#
set -euo pipefail

PROJECT_DIR=${BEELINE_PROD_DIR:-/home/lunchbox/buzz-router-relay-prod}
WEBROOT=$PROJECT_DIR/relay-front/web
BACKUP_ROOT=$PROJECT_DIR/relay-front/web-backups
BACKUP_KEEP=10
PUBLIC_BASE=${BEELINE_PUBLIC_BASE:-https://usebeeline.app}
DRILL=${BEELINE_DEPLOY_DRILL:-}

CHECKOUT=$(git rev-parse --show-toplevel)
REPO_WEB=$CHECKOUT/relay-stack/web
REPO_STACK=$CHECKOUT/relay-stack/prod

log() { echo ">> $*"; }
die() { echo "!! $*" >&2; exit "${2:-1}"; }

[ -d "$REPO_WEB" ] || die "no relay-stack/web in checkout ($CHECKOUT)"
[ -d "$WEBROOT" ] || die "webroot missing: $WEBROOT"

TS=$(date +%Y%m%d-%H%M%S)
STAGE=$(mktemp -d /tmp/beeline-deploy-stage.XXXXXX)
trap 'rm -rf "$STAGE"' EXIT

# ---------------------------------------------------------------------------
# 0. Capture current live identity so we can prove change / no-change later.
# ---------------------------------------------------------------------------
OLD_MANIFEST_SHA=$(sha256sum "$WEBROOT/dl/manifest.json" 2>/dev/null | cut -d' ' -f1 || true)
OLD_AUTH_IMAGE_ID=$(docker image inspect --format '{{.Id}}' beeline-auth:production 2>/dev/null | cut -d: -f2 || true)
log "live dl manifest sha: ${OLD_MANIFEST_SHA:-none}"
log "live auth image id: ${OLD_AUTH_IMAGE_ID:-none}"

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

# Same discipline for the push-gateway image (#340): built BEFORE anything
# live is touched, so a build failure costs nothing.
log "building beeline-push-gateway:production"
docker build -f "$CHECKOUT/apps/push-gateway/Dockerfile" -t beeline-push-gateway:production "$CHECKOUT" \
  >$STAGE/push-build.log 2>&1 || { tail -40 $STAGE/push-build.log >&2; die "push-gateway image build failed"; }
tail -3 $STAGE/push-build.log

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
#     Same discipline as the web swap: verify staged bytes against the
#     checkout, back up everything replaced (timestamped, beside the web
#     backups), apply idempotently (an unchanged merge restarts NOTHING), and
#     roll the config files back if anything below fails. A stack failure
#     must never cost the web deploy its rollback ability: the web backups
#     stay on disk and public verification still runs afterwards.
# ---------------------------------------------------------------------------
LIVE_COMPOSE=$PROJECT_DIR/compose.yml
LIVE_NGINX=$PROJECT_DIR/relay-front/nginx.conf
STACK_STAGE_DIR=${BEELINE_STACK_STAGE_DIR:-$HOME/beeline-deploy-stage}
STACK_DEPLOYED=0
STACK_FAILED=0

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
BUZZY_SNAPSHOT_INTERNAL_TOKEN=stage-dummy
EOF
docker compose -f "$STAGE/stack/compose.validate.yml" --env-file "$STAGE/stack/.env" config --quiet \
  || die "staged compose.yml does not parse — aborting before anything was touched"

# nginx -t in a throwaway container; the network aliases satisfy the upstream
# lookups nginx performs while loading the config (relay/auth/push-gateway).
docker network create beeline-nginx-test >/dev/null 2>&1 || true
if ! docker run --rm --network beeline-nginx-test \
      --network-alias relay --network-alias auth --network-alias push-gateway \
      -v "$STAGE/stack/nginx.conf:/etc/nginx/nginx.conf:ro" \
      nginx:1.27-alpine nginx -t >/dev/null 2>&1; then
  docker network rm beeline-nginx-test >/dev/null 2>&1 || true
  die "staged nginx.conf fails nginx -t — aborting before anything was touched"
fi
docker network rm beeline-nginx-test >/dev/null 2>&1 || true

COMPOSE_CHANGED=0
NGINX_CHANGED=0
cmp -s "$STAGE/stack/compose.yml" "$LIVE_COMPOSE" || COMPOSE_CHANGED=1
cmp -s "$STAGE/stack/nginx.conf" "$LIVE_NGINX" || NGINX_CHANGED=1
GATEWAY_RUNNING=$(docker ps -q --filter label=com.docker.compose.project=buzz-router-prod --filter label=com.docker.compose.service=push-gateway)

# place_stack_file <name> <live-dest>: copy the staged file over the live one
# through the fixed-argument sudo rule. Used for BOTH apply and rollback
# (rollback copies the backup into the stage slot first) because the live
# files are lunchbox-owned and the runner user cannot write them directly.
place_stack_file() {
  sudo -n /usr/bin/install -o lunchbox -g lunchbox -m 644 "$STACK_STAGE_DIR/$1" "$2" \
    || { echo "!! sudo install of $1 failed — is the fixed-argument sudoers rule installed? See the header of scripts/deploy-relay-host.sh" >&2; return 1; }
}

# Plain-docker nginx reload (the runner is in the docker group; no sudo):
# an nginx-content-only change is applied with zero-downtime HUP reload
# instead of any container churn. This only delivers current bytes because
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

rollback_stack_config() {
  local bk="$BACKUP_ROOT/config-$TS"
  [ -d "$bk" ] || return 0
  if [ -f "$bk/compose.yml" ]; then
    cp "$bk/compose.yml" "$STACK_STAGE_DIR/compose.yml"
    place_stack_file compose.yml "$LIVE_COMPOSE" || true
  fi
  if [ -f "$bk/relay-front/nginx.conf" ]; then
    cp "$bk/relay-front/nginx.conf" "$STACK_STAGE_DIR/nginx.conf"
    place_stack_file nginx.conf "$LIVE_NGINX" || true
  fi
}

# Converge the RUNNING stack to whatever compose.yml is currently on disk.
# Best-effort: used after a rollback, never hides a primary failure.
converge_stack_runtime() {
  sudo -n /usr/bin/docker compose -p buzz-router-prod --env-file "$PROJECT_DIR/.env" \
    -f "$LIVE_COMPOSE" up -d >>$STAGE/stack-up.log 2>&1 \
    || echo "!! converge 'compose up -d' failed after config restore — INSPECT MANUALLY" >&2
  reload_relay_front_nginx || true
}

# Wait without changing the fixed sudo command shape. All services with an
# application healthcheck must be healthy, and relay-front (which deliberately
# has no healthcheck) must be running. This closes the gap where `up -d`
# returned while auth still served 502s during run 32684876277.
wait_for_stack_ready() {
  local attempt service expected cid actual all_ready
  for attempt in $(seq 1 36); do
    all_ready=1
    for service in auth push-gateway relay relay-front; do
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
  for service in auth push-gateway relay relay-front; do
    cid=$(docker ps -aq \
      --filter label=com.docker.compose.project=buzz-router-prod \
      --filter label=com.docker.compose.service="$service" | head -1)
    [ -z "$cid" ] || docker inspect --format "$service: status={{.State.Status}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}" "$cid" >&2 || true
  done
  return 1
}

reconcile_full_stack() {
  local compose_log=$STAGE/stack-up.log
  if sudo -n /usr/bin/docker compose -p buzz-router-prod \
      --env-file "$PROJECT_DIR/.env" -f "$LIVE_COMPOSE" up -d \
      >"$compose_log" 2>&1; then
    wait_for_stack_ready
    return
  fi

  # Docker can report a stale container id if another just-finished deployment
  # removed it between Compose's plan and apply (run 32684880925). A second
  # identical reconciliation is safe and convergent; other failures remain
  # immediately actionable and are not retried blindly.
  if grep -q 'No such container' "$compose_log"; then
    log "compose observed a concurrently removed container; retrying convergence once"
    sleep 2
    if sudo -n /usr/bin/docker compose -p buzz-router-prod \
        --env-file "$PROJECT_DIR/.env" -f "$LIVE_COMPOSE" up -d \
        >>"$compose_log" 2>&1; then
      wait_for_stack_ready
      return
    fi
  fi

  tail -20 "$compose_log" >&2
  return 1
}

recreate_auth_only() {
  log "recreating auth container"
  sudo -n /usr/bin/docker compose -p buzz-router-prod \
    --env-file "$PROJECT_DIR/.env" \
    -f "$LIVE_COMPOSE" up -d --no-deps auth \
    || { sudo -n /usr/bin/docker compose -p buzz-router-prod --env-file "$PROJECT_DIR/.env" -f "$LIVE_COMPOSE" up -d --no-deps auth 2>&1 | tail -20; return 1; }
}

if [ "$COMPOSE_CHANGED" = 0 ] && [ "$NGINX_CHANGED" = 0 ] && [ -n "$GATEWAY_RUNNING" ]; then
  recreate_auth_only || die "compose up auth failed"
  log "production stack unchanged — nothing to roll out"
else
  mkdir -p "$STACK_STAGE_DIR" "$BACKUP_ROOT/config-$TS/relay-front"
  [ "$COMPOSE_CHANGED" = 1 ] && cp -p "$LIVE_COMPOSE" "$BACKUP_ROOT/config-$TS/compose.yml"
  [ "$NGINX_CHANGED" = 1 ] && cp -p "$LIVE_NGINX" "$BACKUP_ROOT/config-$TS/relay-front/nginx.conf"
  cp "$STAGE/stack/compose.yml" "$STAGE/stack/nginx.conf" "$STACK_STAGE_DIR/"

  ok=1
  if [ "$COMPOSE_CHANGED" = 1 ]; then place_stack_file compose.yml "$LIVE_COMPOSE" || ok=0; fi
  if [ "$ok" = 1 ] && [ "$NGINX_CHANGED" = 1 ]; then place_stack_file nginx.conf "$LIVE_NGINX" || ok=0; fi

  if [ "$ok" = 1 ]; then
    # Full `up -d` only when the compose config changed or the gateway has
    # never come up (e.g. the very first rollout after adoption, or a
    # manually stopped container). An nginx-content-only change is applied
    # with a zero-downtime HUP reload instead of any container churn.
    if [ "$COMPOSE_CHANGED" = 1 ] || [ -z "$GATEWAY_RUNNING" ]; then
      log "applying production stack (docker compose up -d)"
      # One reconciliation owns auth + gateway + front, followed by an
      # explicit container-health gate. The former auth-only `up` immediately
      # followed by a full `up` raced the same auth container: run 32684876277
      # served auth 502s for the whole public-verification budget, and the next
      # run observed Docker removing a container underneath Compose.
      reconcile_full_stack || ok=0
    else
      recreate_auth_only || ok=0
    fi
    if [ "$ok" = 1 ] && [ "$NGINX_CHANGED" = 1 ]; then reload_relay_front_nginx || ok=0; fi
  fi

  if [ "$ok" = 1 ]; then
    STACK_DEPLOYED=1
    log "production stack rolled out"
  else
    STACK_FAILED=1
    echo "!! STACK ROLLOUT FAILED — restoring previous stack config" >&2
    rollback_stack_config
    converge_stack_runtime
  fi
fi

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

  # Push gateway healthy through the front — only asserted when THIS deploy
  # rolled the stack forward; after a stack failure+restore the old (possibly
  # gateway-less) config is deliberately what public verification should see.
  if [ "${STACK_DEPLOYED:-0}" = "1" ]; then
    local tries_p=0 code_push=""
    while [ $tries_p -lt 12 ]; do
      code_push=$(curl -fsS -o /dev/null -w '%{http_code}' --max-time 15 "$PUBLIC_BASE/push/health" || true)
      [ "$code_push" = "200" ] && break
      tries_p=$((tries_p+1)); sleep 5
    done
    [ "$code_push" = "200" ] || { echo "!! /push/health did not return 200 (last: ${code_push:-error})" >&2; failures=$((failures+1)); }
    log "public /push/health verified"
    code_snapshot=$(curl -fsS -o /dev/null -w '%{http_code}' --max-time 15 "$PUBLIC_BASE/snapshot/health" || true)
    [ "$code_snapshot" = "200" ] || { echo "!! /snapshot/health did not return 200 (last: ${code_snapshot:-error})" >&2; failures=$((failures+1)); }
    log "public /snapshot/health verified"
  fi

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

NEW_AUTH_IMAGE_ID=$(docker image inspect --format '{{.Id}}' beeline-auth:production | cut -d: -f2)

rollback() {
  log "ROLLBACK: restoring previous web tree, auth image, and stack config"
  rsync -a -O --no-p --no-o --no-g --delete "$BAK/" "$WEBROOT/"
  if [ -n "$OLD_AUTH_IMAGE_ID" ] && [ "$OLD_AUTH_IMAGE_ID" != "$NEW_AUTH_IMAGE_ID" ]; then
    docker tag "$OLD_AUTH_IMAGE_ID" beeline-auth:rollback-prev 2>/dev/null || true
    docker tag "sha256:$OLD_AUTH_IMAGE_ID" beeline-auth:production 2>/dev/null || true
    sudo -n /usr/bin/docker compose -p buzz-router-prod --env-file "$PROJECT_DIR/.env" \
      -f "$PROJECT_DIR/compose.yml" up -d --no-deps auth || echo "!! rollback compose up failed — inspect manually" >&2
  fi
  if [ "${STACK_DEPLOYED:-0}" = "1" ]; then
    rollback_stack_config
    converge_stack_runtime
    # Post-rollback public verification must judge the RESTORED config —
    # which may legitimately have no gateway — not the rolled-forward one.
    STACK_DEPLOYED=0
  fi
}

# Public verification with a short retry loop (edge caches may lag seconds).
verified=0
for attempt in 1 2 3; do
  if verify_public; then verified=1; break; fi
  log "public verification attempt $attempt failed; retrying after 20s"
  sleep 20
done

if [ $verified -ne 1 ]; then
  echo "!! PUBLIC verification failed after retries" >&2
  echo "!! the deploy did NOT reach users correctly — rolling back" >&2
  rollback
  if verify_public; then
    die "rolled back; previous working content is served again" 1
  else
    die "rolled back BUT public still not serving backup content — INSPECT MANUALLY" 1
  fi
fi

if [ "$STACK_FAILED" = "1" ]; then
  die "web+auth deployed and verified, but the STACK ROLLOUT FAILED and was rolled back — see the stack-up log tail above and the sudoers note in scripts/deploy-relay-host.sh" 1
fi

# ---------------------------------------------------------------------------
# 6. Prune old backups.
# ---------------------------------------------------------------------------
# '|| true' keeps an unmatched glob (no backups yet) from tripping
# pipefail+set -e; pruning is housekeeping, never worth failing a deploy.
ls -1dt "$BACKUP_ROOT"/bak-* 2>/dev/null | tail -n +$((BACKUP_KEEP+1)) | while read -r old; do rm -rf "$old"; done || true
ls -1dt "$BACKUP_ROOT"/config-* 2>/dev/null | tail -n +$((BACKUP_KEEP+1)) | while read -r old; do rm -rf "$old"; done || true

log "OK: public origin serves this deploy (checkout $(git -C "$CHECKOUT" rev-parse HEAD))"
log "done."
