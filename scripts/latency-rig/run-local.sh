#!/usr/bin/env bash
# Run the current monolith against a disposable local PostgreSQL fixture.
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
database_url="${LATENCY_RIG_DATABASE_URL:-postgresql://localhost/beeline_latency_rig?host=%2Fvar%2Frun%2Fpostgresql}"
if [[ "$database_url" != *localhost* && "$database_url" != *127.0.0.1* ]]; then
  echo 'Refusing non-loopback latency rig database' >&2
  exit 2
fi
if [[ "$database_url" != *latency_rig* ]]; then
  echo 'Database name must contain latency_rig' >&2
  exit 2
fi
review_secret="${LATENCY_RIG_REVIEW_SECRET:-}"
if [[ ! "$review_secret" =~ ^[A-Za-z0-9_-]{24,128}$ ]]; then
  echo 'Set LATENCY_RIG_REVIEW_SECRET to a local-only 24–128 character value' >&2
  exit 2
fi
export DATABASE_URL="$database_url"
export MIGRATION_DATABASE_URL="$database_url"
export LATENCY_RIG_DATABASE_URL="$database_url"
export BEELINE_REVIEW_SECRET="$review_secret"
export NODE_ENV=development
export PUBLIC_ORIGIN="http://127.0.0.1:${LATENCY_RIG_SERVER_PORT:-8080}"
export PORT="${LATENCY_RIG_SERVER_PORT:-8080}"
export HOST=127.0.0.1
export BEELINE_SERVER_MACHINES=1
export PUSH_DELIVERY_ENABLED=false
export BUZZY_AUTH_TENANTS_JSON="[{\"host\":\"127.0.0.1:${PORT}\",\"community\":\"latency-rig\",\"roomCommunityIds\":[\"latency-rig\"],\"origin\":\"${PUBLIC_ORIGIN}\"}]"
export BUZZY_AUTH_OIDC_ISSUER="${PUBLIC_ORIGIN}/unused-oidc"
export BUZZY_AUTH_OIDC_AUTHORIZATION_ENDPOINT="${PUBLIC_ORIGIN}/unused-authorize"
export BUZZY_AUTH_OIDC_TOKEN_ENDPOINT="${PUBLIC_ORIGIN}/unused-token"
export BUZZY_AUTH_OIDC_JWKS_URI="${PUBLIC_ORIGIN}/unused-jwks"
export BUZZY_AUTH_OIDC_CLIENT_ID=latency-rig
export BUZZY_AUTH_ALLOW_INSECURE_OIDC=true
export LATENCY_RIG_SQL_LOG="${LATENCY_RIG_SQL_LOG:-$repo_dir/scripts/latency-rig/local-sql.ndjson}"
export LATENCY_RIG_PROXY_LOG="${LATENCY_RIG_PROXY_LOG:-$repo_dir/scripts/latency-rig/local-proxy.ndjson}"
export LATENCY_RIG_BACKEND="$PUBLIC_ORIGIN"

cd "$repo_dir"
if ! psql "$database_url" -Atqc 'SELECT 1' >/dev/null 2>&1; then
  createdb beeline_latency_rig
fi
npx turbo run build --filter=@beeline/server...
npm run migrate -w @beeline/server
node scripts/latency-rig/seed-local.mjs

server_pid=""
proxy_pid=""
cleanup() {
  [[ -z "$proxy_pid" ]] || kill "$proxy_pid" 2>/dev/null || true
  [[ -z "$server_pid" ]] || kill "$server_pid" 2>/dev/null || true
}
trap cleanup EXIT INT TERM
NODE_OPTIONS="--require $repo_dir/scripts/latency-rig/pg-probe.cjs" \
  node --import tsx apps/server/src/index.ts &
server_pid=$!
for _ in {1..60}; do
  if curl -fsS "$PUBLIC_ORIGIN/healthz" >/dev/null; then break; fi
  sleep 1
done
curl -fsS "$PUBLIC_ORIGIN/healthz" >/dev/null
node scripts/latency-rig/proxy.mjs &
proxy_pid=$!
echo "Local rig ready. Point the release app at http://10.0.2.2:${LATENCY_RIG_PORT:-8081}."
echo 'Use the local-only review link on the device; never use a production Workspace.'
wait "$server_pid"
