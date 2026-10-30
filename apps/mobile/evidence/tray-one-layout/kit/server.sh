#!/usr/bin/env bash
# Local @beeline/server for the Tray before/after screenshots.
set -euo pipefail
REPO=/home/alan/.local/state/beeline/corners/cf8ffb2b-4d7e-40dd-9844-6452ba9889b0
export DATABASE_URL="postgres://latency_rig:local-proof-only@127.0.0.1:55494/tray_latency_rig"
export MIGRATION_DATABASE_URL="$DATABASE_URL"
export NODE_ENV=development
export PORT=8897 HOST=127.0.0.1
export PUBLIC_ORIGIN="http://127.0.0.1:8897"
export BEELINE_WEB_APP_ORIGINS="http://127.0.0.1:8483,http://localhost:8483"
export BEELINE_REVIEW_SECRET="niglet-tray-local-review-secret-01"
export BEELINE_AUTH_TENANTS_JSON='[{"host":"127.0.0.1:8897","community":"ctray","roomCommunityIds":["ctray"],"origin":"http://127.0.0.1:8897"}]'
export BEELINE_AUTH_OIDC_ISSUER="https://accounts.example"
export BEELINE_AUTH_OIDC_AUTHORIZATION_ENDPOINT="https://accounts.example/authorize"
export BEELINE_AUTH_OIDC_TOKEN_ENDPOINT="https://accounts.example/token"
export BEELINE_AUTH_OIDC_JWKS_URI="https://accounts.example/jwks"
export BEELINE_AUTH_OIDC_CLIENT_ID="ctray-client"
cd "$REPO/apps/server"
if [[ "${1:-}" == "--migrate" ]]; then exec node --import tsx src/index.ts --migrate; fi
exec node --import tsx src/index.ts
