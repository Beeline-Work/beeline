#!/usr/bin/env bash
#
# Promote the most recent release on one Play track onto another (for example
# internal → beta, where the API name "beta" is Play Console's "Open testing")
# through the AndroidPublisher REST API. Called from
# .github/workflows/play-promote.yml.
#
# Required environment:
#   ACCESS_TOKEN     — OAuth access token with the androidpublisher scope
#   PACKAGE_NAME     — app.usebeeline.mobile
#   FROM_TRACK       — internal | alpha | beta
#   TO_TRACK         — alpha | beta | production
#   RELEASE_STATUS   — draft | completed
#                       draft     = lands on TO_TRACK as "Ready to publish"; you
#                                   still press Release / Send to testers in Play
#                                   Console. Safe default for a track's first
#                                   roll-out, which starts Google's review.
#                       completed = auto-publishes once any review completes.
# Optional:
#   PLAY_DRY_RUN=1   — print the API calls instead of making them (see play-api.sh)
#
# Re-running with the same FROM/TO re-sends the same versionCode, which Google
# rejects with a clear error; a newer FROM_TRACK release promotes cleanly.

set -euo pipefail

# shellcheck source=scripts/play-api.sh
source "$(dirname "${BASH_SOURCE[0]}")/play-api.sh"

: "${FROM_TRACK:?FROM_TRACK env var is required (internal|alpha|beta)}"
: "${TO_TRACK:?TO_TRACK env var is required (alpha|beta|production)}"
: "${RELEASE_STATUS:?RELEASE_STATUS env var is required (draft|completed)}"

echo "▸ Creating edit"
EDIT_ID=$(api POST "$API/edits" -H 'Content-Type: application/json' -d '{}' | json_field id)
echo "  editId = $EDIT_ID"

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

echo "▸ Validating edit"
api POST "$API/edits/$EDIT_ID:validate" -H "Content-Length: 0" >/dev/null
echo "  ok"

echo "▸ Committing edit"
api POST "$API/edits/$EDIT_ID:commit" -H "Content-Length: 0" >/dev/null
echo "  $FROM_TRACK → $TO_TRACK promotion committed."
echo ""
case "$RELEASE_STATUS" in
  draft)
    echo "Release is 'Ready to publish' on $TO_TRACK. Press Release / Send to testers"
    echo "in Play Console; a track's first roll-out starts Google's review."
    ;;
  completed)
    echo "Release auto-publishes on $TO_TRACK once any Google review completes."
    ;;
  *)
    echo "status=$RELEASE_STATUS — Play Console shows the resulting state."
    ;;
esac
echo ""
echo "Play Console: $(play_console_url)"
