#!/usr/bin/env bash
#
# Operator recovery: promote the newest explicitly selected beta release to
# production as completed, preserving its name and notes and sending it for
# review. Listing text/images remain locked unless explicitly authorized.
# Required: ACCESS_TOKEN, PACKAGE_NAME, FROM_TRACK=beta.
# Optional: TO_TRACK=production, RELEASE_STATUS=completed, PLAY_DRY_RUN=1.
# See apps/mobile/docs/store-submission.md for owner-command requirements.

set -euo pipefail

# shellcheck source=scripts/play-api.sh
source "$(dirname "${BASH_SOURCE[0]}")/play-api.sh"

: "${FROM_TRACK:?FROM_TRACK=beta is required}"
export TO_TRACK="${TO_TRACK:-production}"
export RELEASE_STATUS="${RELEASE_STATUS:-completed}"
if [ "$FROM_TRACK" != beta ] || [ "$TO_TRACK" != production ] || [ "$RELEASE_STATUS" != completed ]; then
  echo '::error::Recovery promotion requires beta to production with completed status' >&2
  exit 1
fi

echo "▸ Creating edit"
EDIT_ID=$(api POST "$API/edits" -H 'Content-Type: application/json' -d '{}' | json_field id)
echo "  editId = $EDIT_ID"
export PLAY_EDIT_ID="$EDIT_ID"
if [ "${PUBLISH_LISTING:-false}" != true ]; then
  PLAY_LISTING_BASELINE="${PLAY_LISTING_BASELINE:-$(mktemp)}"
  export PLAY_LISTING_BASELINE
  node "$(dirname "${BASH_SOURCE[0]}")/play-listing-lock.mjs" snapshot "$PLAY_LISTING_BASELINE"
fi

echo "▸ Reading $FROM_TRACK track"
SOURCE_TRACK=$(api GET "$API/edits/$EDIT_ID/tracks/$FROM_TRACK")

# The release with the highest versionCode is the most recent upload. Carry its
# name and release notes across; Google complains when a promoted release
# arrives without notes.
PROMOTED_RELEASE=$(FROM_JSON="$SOURCE_TRACK" python3 <<'PY'
import json, os, sys
src = json.loads(os.environ["FROM_JSON"])
releases = src.get("releases", [])
if not releases:
    print("::error::no releases on source track to promote", file=sys.stderr)
    sys.exit(1)
def maxvc(r):
    codes = r.get("versionCodes") or []
    return max(int(c) for c in codes) if codes else 0
chosen = max(releases, key=maxvc)
out = {
    "name": chosen.get("name") or f"promoted-vc-{maxvc(chosen)}",
    "versionCodes": chosen["versionCodes"],
    "status": os.environ["RELEASE_STATUS"],
}
if chosen.get("releaseNotes"):
    out["releaseNotes"] = chosen["releaseNotes"]
print(json.dumps(out))
PY
)
echo "  promoting versionCode(s): $(echo "$PROMOTED_RELEASE" | json_field versionCodes)"

echo "▸ Writing $TO_TRACK track"
TO_TRACK_BODY=$(PROMOTED="$PROMOTED_RELEASE" python3 -c '
import json, os
print(json.dumps({
    "track": os.environ["TO_TRACK"],
    "releases": [json.loads(os.environ["PROMOTED"])],
}))')
api PUT "$API/edits/$EDIT_ID/tracks/$TO_TRACK" \
    -H 'Content-Type: application/json' \
    -d "$TO_TRACK_BODY" >/dev/null

echo "▸ Committing edit after the listing lock"
bash "$(dirname "${BASH_SOURCE[0]}")/play-commit-build.sh"
echo "  $FROM_TRACK → $TO_TRACK promotion committed; full rollout follows approval."
echo "Play Console: $(play_console_url)"
