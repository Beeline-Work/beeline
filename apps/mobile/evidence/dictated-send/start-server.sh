#!/usr/bin/env bash
# Disposable local deployment of the real server, with the real Groq model.
set -euo pipefail
repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd -P)"
export DATABASE_URL="${DICTATION_DATABASE_URL:-postgresql://localhost/beeline_latency_rig_dictation?host=%2Fvar%2Frun%2Fpostgresql}"
if [[ "$DATABASE_URL" != *localhost* && "$DATABASE_URL" != *127.0.0.1* ]]; then
  echo 'Replay server requires a loopback database' >&2; exit 2
fi
if [[ "$DATABASE_URL" != *latency_rig* ]]; then
  echo 'Replay database name must contain latency_rig' >&2; exit 2
fi
: "${DICTATION_REVIEW_SECRET:?Set a fresh local-only review secret in the server and replay shells}"
: "${GROQ_API_KEY:?Configure the real Groq key or vaulted egress token only in this backend environment}"
export BEELINE_REVIEW_SECRET="$DICTATION_REVIEW_SECRET"
export MIGRATION_DATABASE_URL="$DATABASE_URL"
export NODE_ENV=development
export HOST=127.0.0.1
export PORT="${DICTATION_SERVER_PORT:-19347}"
export PUBLIC_ORIGIN="http://127.0.0.1:$PORT"
export BEELINE_SERVER_MACHINES=1
export BEELINE_AUTH_TENANTS_JSON="[{\"host\":\"127.0.0.1:$PORT\",\"community\":\"dictation-replay\",\"roomCommunityIds\":[\"dictation-replay\"],\"origin\":\"$PUBLIC_ORIGIN\"}]"
export BEELINE_AUTH_OIDC_ISSUER="$PUBLIC_ORIGIN/unused-oidc"
export BEELINE_AUTH_OIDC_AUTHORIZATION_ENDPOINT="$PUBLIC_ORIGIN/unused-authorize"
export BEELINE_AUTH_OIDC_TOKEN_ENDPOINT="$PUBLIC_ORIGIN/unused-token"
export BEELINE_AUTH_OIDC_JWKS_URI="$PUBLIC_ORIGIN/unused-jwks"
export BEELINE_AUTH_OIDC_CLIENT_ID=dictation-replay
export BEELINE_AUTH_ALLOW_INSECURE_OIDC=true
cd "$repo_dir"
npx turbo run build --filter=@beeline/server... --concurrency=2
npm run migrate -w @beeline/server
exec node --require ./apps/mobile/evidence/dictated-send/staging-groq-egress.cjs apps/server/dist/index.js
