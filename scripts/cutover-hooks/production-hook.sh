#!/usr/bin/env bash
set -euo pipefail
# shellcheck disable=SC1091 # Dynamic sibling path; lib.sh is linted separately by lint:shell.
source "$(dirname -- "$0")/lib.sh"

mode="${1:-}"
shift || true

phone_auth_verify() {
  require curl; require jq; require node; require psql; require sha256sum; require flyctl; require timeout
  need DATABASE_URL; need CUTOVER_MONOLITH_APP; need CUTOVER_MONOLITH_ORIGIN
  need CUTOVER_PHONE_SESSION_FILE; need CUTOVER_OWNER_GITHUB_SUBJECT; need CUTOVER_OWNER_GITHUB_LOGIN
  expect_https_origin CUTOVER_MONOLITH_ORIGIN "$CUTOVER_MONOLITH_ORIGIN"
  local configured ticket first replay tmp
  configured="$(timeout 30s flyctl ssh console --app "$CUTOVER_MONOLITH_APP" --command 'printenv PHONE_GITHUB_EXCHANGE_ENDPOINT' 2>/dev/null | tr -d '\r\n')"
  [[ -z "$configured" ]] || die 'PHONE_GITHUB_EXCHANGE_ENDPOINT must be unset for in-process verification'
  ticket="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))')"
  [[ "$ticket" =~ ^[A-Za-z0-9_-]{43}$ ]] || die 'monolith probe did not mint a bounded ticket'
  local ticket_hash challenge community
  ticket_hash="$(printf '%s' "$ticket" | sha256sum | cut -d' ' -f1)"
  challenge="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))')"
  community="$(flyctl ssh console --app "$CUTOVER_MONOLITH_APP" --command 'printenv BUZZY_AUTH_TENANTS_JSON' 2>/dev/null | tr -d '\r' | jq -er --arg host "${CUTOVER_MONOLITH_ORIGIN#https://}" '.[] | select(.host == $host) | .community')"
  PGOPTIONS='-c client_min_messages=warning' psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 \
    -v ticket_hash="$ticket_hash" -v challenge="$challenge" -v community="$community" \
    -v subject="$CUTOVER_OWNER_GITHUB_SUBJECT" -v login="$CUTOVER_OWNER_GITHUB_LOGIN" \
    -v display_name="${CUTOVER_OWNER_GITHUB_NAME:-$CUTOVER_OWNER_GITHUB_LOGIN}" \
    -c "INSERT INTO beeline_bind_tickets(ticket_hash,challenge,community,issuer,audience,subject,created_at,expires_at,provider_login,provider_display_name) VALUES(:'ticket_hash',:'challenge',:'community','https://github.com','github',:'subject',now(),now()+interval '2 minutes',:'login',:'display_name')" >/dev/null
  tmp="$(mktemp)"; trap 'rm -f "$tmp"' RETURN
  first="$(curl_code "$tmp" -H 'content-type: application/json' --data "$(jq -nc --arg t "$ticket" '{oidcToken:$t}')" "$CUTOVER_MONOLITH_ORIGIN/v1/auth/github/exchange")"
  [[ "$first" == 200 ]] || die "monolith phone exchange returned HTTP $first"
  jq -e '(.accessToken|startswith("bat_")) and (.refreshToken|startswith("brt_"))' "$tmp" >/dev/null || die 'phone exchange returned invalid tokens'
  umask 077; install -m 600 "$tmp" "$CUTOVER_PHONE_SESSION_FILE"
  replay="$(curl_code "$tmp" -H 'content-type: application/json' --data "$(jq -nc --arg t "$ticket" '{oidcToken:$t}')" "$CUTOVER_MONOLITH_ORIGIN/v1/auth/github/exchange")"
  [[ "$replay" =~ ^(400|401|409)$ ]] || die "ticket reuse was not rejected (HTTP $replay)"
}

drain() {
  require systemctl
  mapfile -t ids < <(agent_ids)
  units=(); for id in "${ids[@]}"; do units+=("beeline-agent@${id}.service"); done
  systemctl --user stop --no-block "${units[@]}"
}

drain_verify() {
  require systemctl; require psql; need OLD_DATABASE_URL
  local id state count
  while IFS= read -r id; do
    state="$(systemctl --user show -p ActiveState --value "beeline-agent@${id}.service")"
    [[ "$state" == inactive ]] || die "daemon $id is still $state"
  done < <(agent_ids)
  count="$(psql "$OLD_DATABASE_URL" -X -v ON_ERROR_STOP=1 -Atqc "WITH latest AS (SELECT DISTINCT ON (channel_id,pubkey) (SELECT t->>1 FROM jsonb_array_elements(tags) t WHERE t->>0='status' LIMIT 1) status FROM events WHERE kind=9 AND deleted_at IS NULL AND tags @> '[[\"t\",\"agent-turn\"]]'::jsonb ORDER BY channel_id,pubkey,created_at DESC,id DESC) SELECT count(*) FROM latest WHERE status='working'")"
  [[ "$count" == 0 ]] || die "$count active old-stack turns remain"
}

freeze() {
  require docker; need CUTOVER_OLD_STACK_DIR
  local deployed="$CUTOVER_OLD_STACK_DIR/relay-front/cutover-write-freeze.conf" tmp
  tmp="$(mktemp "$CUTOVER_OLD_STACK_DIR/relay-front/.cutover-freeze.XXXXXX")"
  cat >"$tmp" <<'EOF'
location = /events {
  if ($request_method = POST) { return 503; }
  add_header X-Beeline-Cutover-Freeze active always;
  return 405;
}
EOF
  chmod 644 "$tmp"; mv -f "$tmp" "$deployed"
  docker compose --project-directory "$CUTOVER_OLD_STACK_DIR" exec -T relay-front nginx -t
  docker compose --project-directory "$CUTOVER_OLD_STACK_DIR" kill -s HUP relay-front
}

freeze_verify() {
  require curl; require jq; need CUTOVER_OLD_ORIGIN; need CUTOVER_OLD_ROOMVIEW_URL; need CUTOVER_OLD_ROOMVIEW_AUTH_FILE; need CUTOVER_OLD_WRITE_PROBE_FILE
  secure_file CUTOVER_OLD_ROOMVIEW_AUTH_FILE "$CUTOVER_OLD_ROOMVIEW_AUTH_FILE"
  secure_file CUTOVER_OLD_WRITE_PROBE_FILE "$CUTOVER_OLD_WRITE_PROBE_FILE"
  local auth body code headers
  auth="$(<"$CUTOVER_OLD_ROOMVIEW_AUTH_FILE")"; body="$(mktemp)"; headers="$(mktemp)"; trap 'rm -f "$body" "$headers"' RETURN
  code="$(curl --silent --show-error --max-time 20 -D "$headers" -o "$body" -w '%{http_code}' -H 'content-type: application/json' --data-binary "@$CUTOVER_OLD_WRITE_PROBE_FILE" "$CUTOVER_OLD_ORIGIN/events")"
  if [[ "$code" != 503 ]] || ! grep -qi '^X-Beeline-Cutover-Freeze: active' "$headers"; then
    die 'old /events is not frozen by cutover nginx'
  fi
  code="$(curl_code "$body" -H "Authorization: $auth" "$CUTOVER_OLD_ROOMVIEW_URL")"
  if [[ "$code" != 200 ]] || ! jq -e 'type=="object"' "$body" >/dev/null; then
    die "old RoomView read failed (HTTP $code)"
  fi
}

daemon_restart() {
  require systemctl
  local id; while IFS= read -r id; do systemctl --user restart --no-block "beeline-agent@${id}.service"; done < <(agent_ids)
}

daemon_verify() {
  require jq; require curl; need CUTOVER_MONOLITH_ORIGIN
  local id path token code body deadline=$((SECONDS + ${CUTOVER_DAEMON_VERIFY_TIMEOUT_SECONDS:-180}))
  while (( SECONDS < deadline )); do
    local pending=0
    while IFS= read -r id; do
      path="$(runtime_path "$id")"; secure_file "runtime for $id" "$path"
      if ! jq -e --arg origin "$CUTOVER_MONOLITH_ORIGIN" '.transport.kind=="monolith" and .transport.baseUrl==$origin and (.transport.daemonToken|startswith("bdt_")) and (.transport|has("exchangeToken")|not)' "$path" >/dev/null; then pending=1; continue; fi
      token="$(jq -er '.transport.daemonToken' "$path")"; body="$(mktemp)"
      code="$(curl_code "$body" -H "Authorization: Bearer $token" -H 'content-type: application/json' --data "$(jq -nc --arg a "$id" '{agentId:$a}')" "$CUTOVER_MONOLITH_ORIGIN/v1/daemon/operations/getDaemonBootstrap")"
      rm -f "$body"; [[ "$code" == 200 ]] || pending=1
    done < <(agent_ids)
    (( pending == 0 )) && return 0
    sleep 2
  done
  die 'daemon runtimes did not promote bde_ to working bdt_ credentials before timeout'
}

ota_flip() {
  require node; require jq; require git; need CUTOVER_OTA_LEDGER; need CUTOVER_OTA_DELIVERY_INDEX; need CUTOVER_CUT_SHA; need CUTOVER_CUT_VERSION
  [[ "$(jq -r '.sourceSha' "$CUTOVER_OTA_LEDGER")" == "$CUTOVER_CUT_SHA" ]] || die 'OTA ledger SHA is not the cut candidate'
  [[ "$(jq -r '.releaseVersion' "$CUTOVER_OTA_LEDGER")" == "$CUTOVER_CUT_VERSION" ]] || die 'OTA ledger version is not the cut version'
  git -C "$REPO_ROOT" show "$CUTOVER_CUT_SHA:apps/mobile/app.config.js" | grep -Fq 'const buzzyMonolithEnabled = true;' || die 'cut SHA does not contain the production monolith switch flip'
  (cd "$REPO_ROOT/apps/mobile" && node scripts/ota-release.mjs mark-canary --ledger "$CUTOVER_OTA_LEDGER" --status post-promote && node scripts/ota-release.mjs promote --ledger "$CUTOVER_OTA_LEDGER" --index "$CUTOVER_OTA_DELIVERY_INDEX" && node scripts/ota-release.mjs assert-promotion --ledger "$CUTOVER_OTA_LEDGER" --index "$CUTOVER_OTA_DELIVERY_INDEX")
}

ota_verify() {
  require curl; require jq; need CUTOVER_OWNER_PUBKEY; need CUTOVER_OTA_RECEIPT_TOKEN_FILE; need CUTOVER_OTA_LEDGER; need CUTOVER_OTA_RECEIPT_ORIGIN
  expect_hex64 CUTOVER_OWNER_PUBKEY "$CUTOVER_OWNER_PUBKEY"
  local token receipt group version sha
  token="$(token_from_file CUTOVER_OTA_RECEIPT_TOKEN_FILE "$CUTOVER_OTA_RECEIPT_TOKEN_FILE")"; receipt="$(mktemp)"; trap 'rm -f "$receipt"' RETURN
  curl --fail --silent --show-error --max-time 20 -H "Authorization: Bearer $token" "$CUTOVER_OTA_RECEIPT_ORIGIN/update-receipts/$CUTOVER_OWNER_PUBKEY" -o "$receipt"
  group="$(jq -er '.production.groupId' "$CUTOVER_OTA_LEDGER")"; version="$(jq -er '.releaseVersion' "$CUTOVER_OTA_LEDGER")"; sha="$(jq -er '.sourceSha' "$CUTOVER_OTA_LEDGER")"
  jq -e --arg g "$group" --arg v "$version" --arg s "$sha" '.devices|any(.environment=="physical" and .group==$g and .releaseVersion==$v and .sourceSha==$s)' "$receipt" >/dev/null || die 'owner physical device has not reported the exact cut OTA'
}

e2e_verify() {
  require node; need CUTOVER_E2E_CONFIG_FILE; secure_file CUTOVER_E2E_CONFIG_FILE "$CUTOVER_E2E_CONFIG_FILE"
  node "$HOOK_DIR/production-e2e.mjs" "$CUTOVER_E2E_CONFIG_FILE"
}

reopen() {
  # Clients were the admission gate: the exact OTA and daemon cut are already
  # proven above. Reopen is intentionally the removal of the old writer only.
  freeze_verify
  ota_verify
  daemon_verify
}

reopen_verify() {
  e2e_verify
  freeze_verify
}

rollback_daemons() {
  require jq
  local id path tmp; paths=()
  while IFS= read -r id; do
    path="$(runtime_path "$id")"; secure_file "runtime for $id" "$path"
    jq -e --arg id "$id" '.version==2 and .agent.publicKey==$id' "$path" >/dev/null || die "runtime identity mismatch for $id"
    paths+=("$path")
  done < <(agent_ids)
  for path in "${paths[@]}"; do tmp="${path}.rollback-$$"; jq 'del(.transport)' "$path" >"$tmp"; chmod 600 "$tmp"; mv -f "$tmp" "$path"; done
  daemon_restart
}

rollback_ota() {
  require node; require docker; need CUTOVER_OTA_LEDGER; need CUTOVER_OTA_ROLLBACK_LEDGER; need CUTOVER_OLD_STACK_DIR; local previous current
  previous="$(jq -er '.previousProductionGroupId' "$CUTOVER_OTA_LEDGER")"; current="$(jq -er '.production.groupId' "$CUTOVER_OTA_LEDGER")"
  (cd "$REPO_ROOT/apps/mobile" && node scripts/ota-release.mjs rollback --group "$previous" --expected-current-group "$current" --ledger "$CUTOVER_OTA_ROLLBACK_LEDGER")
  jq -e '.status=="rolled-back" and (.productionGroupId|type=="string")' "$CUTOVER_OTA_ROLLBACK_LEDGER" >/dev/null || die 'OTA rollback did not republish the expected previous group; old writes remain frozen'
  install -m 644 "$REPO_ROOT/relay-stack/prod/cutover-write-freeze.conf" "$CUTOVER_OLD_STACK_DIR/relay-front/cutover-write-freeze.conf"
  docker compose --project-directory "$CUTOVER_OLD_STACK_DIR" exec -T relay-front nginx -t
  docker compose --project-directory "$CUTOVER_OLD_STACK_DIR" kill -s HUP relay-front
}

rollback_verify() {
  require curl; need CUTOVER_OLD_ORIGIN; need CUTOVER_OLD_ROOMVIEW_URL; need CUTOVER_OLD_ROOMVIEW_AUTH_FILE; need CUTOVER_OLD_WRITE_PROBE_FILE
  secure_file CUTOVER_OLD_ROOMVIEW_AUTH_FILE "$CUTOVER_OLD_ROOMVIEW_AUTH_FILE"
  secure_file CUTOVER_OLD_WRITE_PROBE_FILE "$CUTOVER_OLD_WRITE_PROBE_FILE"
  local auth code body id path
  auth="$(<"$CUTOVER_OLD_ROOMVIEW_AUTH_FILE")"; body="$(mktemp)"; trap 'rm -f "$body"' RETURN
  code="$(curl_code "$body" -H 'content-type: application/json' --data-binary "@$CUTOVER_OLD_WRITE_PROBE_FILE" "$CUTOVER_OLD_ORIGIN/events")"
  [[ "$code" == 200 ]] || die "old /events did not accept the bounded rollback probe (HTTP $code)"
  code="$(curl_code "$body" -H "Authorization: $auth" "$CUTOVER_OLD_ROOMVIEW_URL")"; [[ "$code" == 200 ]] || die 'old RoomView is not readable after rollback'
  while IFS= read -r id; do path="$(runtime_path "$id")"; jq -e 'has("transport")|not' "$path" >/dev/null || die "daemon $id still has monolith transport"; systemctl --user is-active --quiet "beeline-agent@${id}.service" || die "daemon $id is not active"; done < <(agent_ids)
  need CUTOVER_OTA_ROLLBACK_LEDGER; jq -e '.status=="rolled-back" and (.productionGroupId|type=="string")' "$CUTOVER_OTA_ROLLBACK_LEDGER" >/dev/null || die 'OTA rollback ledger is not complete'
}

case "$mode" in
  phone-auth-verify) phone_auth_verify ;;
  drain) drain ;;
  drain-verify) drain_verify ;;
  freeze) freeze ;;
  freeze-verify) freeze_verify ;;
  daemon-restart) daemon_restart ;;
  daemon-verify) daemon_verify ;;
  ota-flip) ota_flip ;;
  ota-verify) ota_verify ;;
  e2e-verify) e2e_verify ;;
  reopen) reopen ;;
  reopen-verify) reopen_verify ;;
  rollback-daemons) rollback_daemons ;;
  rollback-ota) rollback_ota ;;
  rollback-verify) rollback_verify ;;
  *) die 'usage: production-hook.sh phone-auth-verify|drain|drain-verify|freeze|freeze-verify|daemon-restart|daemon-verify|ota-flip|ota-verify|e2e-verify|reopen|reopen-verify|rollback-daemons|rollback-ota|rollback-verify' ;;
esac
