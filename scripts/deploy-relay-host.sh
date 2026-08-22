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
#   2. apps/auth Dockerfile -> beeline-auth:production -> `docker compose up`
#      for the auth service only.
#
# Discipline inherited from deploy-beeline-cli.sh and extended:
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
# `relay-web` group; docker through the `docker` group; the single privileged
# step (`compose up`, which must read lunchbox-owned env files) goes through a
# fixed-argument passwordless sudo rule installed on the host.
set -euo pipefail

PROJECT_DIR=${BEELINE_PROD_DIR:-/home/lunchbox/buzz-router-relay-prod}
WEBROOT=$PROJECT_DIR/relay-front/web
BACKUP_ROOT=$PROJECT_DIR/relay-front/web-backups
BACKUP_KEEP=10
PUBLIC_BASE=${BEELINE_PUBLIC_BASE:-https://usebeeline.app}
DRILL=${BEELINE_DEPLOY_DRILL:-}

CHECKOUT=$(git rev-parse --show-toplevel)
REPO_WEB=$CHECKOUT/relay-stack/web

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

if ! diff -r --brief "$REPO_WEB" "$STAGE/web" >/tmp/beeline-stage-diff.txt 2>&1; then
  cat /tmp/beeline-stage-diff.txt >&2
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
  >/tmp/beeline-auth-build.log 2>&1 || { tail -40 /tmp/beeline-auth-build.log >&2; die "auth image build failed"; }
tail -3 /tmp/beeline-auth-build.log

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
# 4. Recreate the auth container from the new image (auth service only).
# ---------------------------------------------------------------------------
log "recreating auth container"
sudo -n /usr/bin/docker compose -p buzz-router-prod \
  --env-file "$PROJECT_DIR/.env" \
  -f "$PROJECT_DIR/compose.yml" up -d --no-deps auth \
  || { sudo -n /usr/bin/docker compose -p buzz-router-prod --env-file "$PROJECT_DIR/.env" -f "$PROJECT_DIR/compose.yml" up -d --no-deps auth 2>&1 | tail -20; die "compose up auth failed"; }

# ---------------------------------------------------------------------------
# 5. PUBLIC verification — the only proof that counts.
# ---------------------------------------------------------------------------
pub_sha() { curl -fsSL --max-time 120 "$1" | sha256sum | cut -d' ' -f1; }

verify_public() {
  local failures=0

  # install.sh byte-for-byte.
  if [ "$(pub_sha "$PUBLIC_BASE/install")" != "$(sha256sum "$STAGE/web/install.sh" | cut -d' ' -f1)" ]; then
    echo "!! public /install does not serve the deployed install.sh" >&2; failures=$((failures+1))
  else log "public /install verified"; fi

  # manifest byte-for-byte, plus both advertised bundles present at their
  # real public URLs and matching BOTH their sidecar and the manifest entry.
  if [ "$(pub_sha "$PUBLIC_BASE/dl/manifest.json")" != "$(sha256sum "$STAGE/web/dl/manifest.json" | cut -d' ' -f1)" ]; then
    echo "!! public /dl/manifest.json does not serve the deployed manifest" >&2; failures=$((failures+1))
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
  ' "$STAGE/web/dl/manifest.json" > /tmp/beeline-manifest-bundles.txt || die "unreadable manifest"

  while IFS=$'\t' read -r file want; do
    got=$(pub_sha "$PUBLIC_BASE/dl/$file")
    if [ "$got" != "$want" ]; then
      echo "!! public /dl/$file serves ${got:-nothing}, manifest says $want" >&2; failures=$((failures+1))
    else log "public bundle verified: $file"; fi
    side=$(curl -fsSL --max-time 60 "$PUBLIC_BASE/dl/$file.sha256" | awk '{print $1}')
    [ "$side" = "$want" ] || { echo "!! public .sha256 sidecar for $file disagrees with manifest" >&2; failures=$((failures+1)); }
  done < /tmp/beeline-manifest-bundles.txt

  # Well-known association documents must still resolve.
  for wk in apple-app-site-association assetlinks.json; do
    code=$(curl -fsS -o /dev/null -w '%{http_code}' --max-time 30 "$PUBLIC_BASE/.well-known/$wk" || true)
    [ "$code" = "200" ] || { echo "!! /.well-known/$wk returned ${code:-error}" >&2; failures=$((failures+1)); }
  done

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
  log "ROLLBACK: restoring previous web tree and auth image"
  rsync -a -O --no-p --no-o --no-g --delete "$BAK/" "$WEBROOT/"
  if [ -n "$OLD_AUTH_IMAGE_ID" ] && [ "$OLD_AUTH_IMAGE_ID" != "$NEW_AUTH_IMAGE_ID" ]; then
    docker tag "$OLD_AUTH_IMAGE_ID" beeline-auth:rollback-prev 2>/dev/null || true
    docker tag "sha256:$OLD_AUTH_IMAGE_ID" beeline-auth:production 2>/dev/null || true
    sudo -n /usr/bin/docker compose -p buzz-router-prod --env-file "$PROJECT_DIR/.env" \
      -f "$PROJECT_DIR/compose.yml" up -d --no-deps auth || echo "!! rollback compose up failed — inspect manually" >&2
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

# ---------------------------------------------------------------------------
# 6. Prune old backups.
# ---------------------------------------------------------------------------
ls -1dt "$BACKUP_ROOT"/bak-* 2>/dev/null | tail -n +$((BACKUP_KEEP+1)) | while read -r old; do rm -rf "$old"; done

log "OK: public origin serves this deploy (checkout $(git -C "$CHECKOUT" rev-parse HEAD))"
log "done."
