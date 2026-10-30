#!/usr/bin/env bash
# CD gate: inspect the exact build edit immediately before committing it.
set -euo pipefail
# shellcheck source=scripts/play-api.sh
source "$(dirname "${BASH_SOURCE[0]}")/play-api.sh"
: "${PLAY_EDIT_ID:?PLAY_EDIT_ID is required}"
if [ "${PUBLISH_LISTING:-false}" = "true" ]; then
  commit_edit "$PLAY_EDIT_ID"
else
  : "${PLAY_LISTING_BASELINE:?PLAY_LISTING_BASELINE is required}"
  node "$(dirname "${BASH_SOURCE[0]}")/play-listing-lock.mjs" verify "$PLAY_LISTING_BASELINE"
  commit_edit "$PLAY_EDIT_ID" hold-for-review
fi
echo "Play build edit committed"
