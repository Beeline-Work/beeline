#!/usr/bin/env bash
#
# Upload an Android App Bundle to a Google Play track through the
# AndroidPublisher REST API: create edit → upload bundle → tracks.update →
# commit. Called from .github/workflows/play-beta.yml after
# google-github-actions/auth has minted an access token for the Play service
# account in the GOOGLE_PLAY_SERVICE_ACCOUNT_JSON secret.
#
# Required environment:
#   ACCESS_TOKEN     — OAuth access token with the androidpublisher scope
#   PACKAGE_NAME     — app.usebeeline.mobile
#   AAB_PATH         — path to the .aab built by EAS (signed by the EAS upload key)
#   TRACK            — internal | alpha | beta | production
#   RELEASE_NAME     — release name shown in Play Console (the app version)
#   RELEASE_STATUS   — draft | completed
#                       draft     = uploaded, not sent to testers; you press
#                                   "Send to testers"/"Release" in Play Console.
#                       completed = released to everyone on the track at once.
# Optional:
#   CHANGELOG_DIR    — per-versionCode release notes dir; <versionCode>.txt wins,
#                      default.txt otherwise (default: the en-US fastlane dir)
#   PLAY_DRY_RUN=1   — print the API calls instead of making them (see play-api.sh)

set -euo pipefail

# shellcheck source=scripts/play-api.sh
source "$(dirname "${BASH_SOURCE[0]}")/play-api.sh"

: "${AAB_PATH:?AAB_PATH env var is required}"
: "${TRACK:?TRACK env var is required (internal|alpha|beta|production)}"
: "${RELEASE_NAME:?RELEASE_NAME env var is required}"
: "${RELEASE_STATUS:?RELEASE_STATUS env var is required (draft|completed)}"
CHANGELOG_DIR="${CHANGELOG_DIR:-apps/mobile/fastlane/metadata/android/en-US/changelogs}"

if [ ! -f "$AAB_PATH" ]; then
  echo "::error::AAB file not found at $AAB_PATH" >&2
  exit 1
fi

echo "1/4 Creating edit..."
edit_id=$(api POST "$API/edits" -H "Content-Length: 0" | json_field id)
echo "  edit id: $edit_id"

echo "2/4 Uploading AAB ($(du -h "$AAB_PATH" | awk '{print $1}'))..."
version_code=$(api POST "$UPLOAD_API/edits/$edit_id/bundles?uploadType=media" \
  -H "Content-Type: application/octet-stream" \
  --data-binary "@${AAB_PATH}" | json_field versionCode)
echo "  uploaded versionCode: $version_code"

echo "3/4 Setting $TRACK track release ($RELEASE_NAME, status=$RELEASE_STATUS)..."
# Release notes ("What's new"): the per-versionCode file wins, then default.txt;
# with neither the release ships without notes. Play caps notes at 500 chars.
notes_file="$CHANGELOG_DIR/$version_code.txt"
[ -f "$notes_file" ] || notes_file="$CHANGELOG_DIR/default.txt"
RELEASE_NOTES=""
if [ -f "$notes_file" ]; then
  RELEASE_NOTES="$(cat "$notes_file")"
  echo "  release notes from: $notes_file"
fi

track_body=$(VERSION_CODE="$version_code" RELEASE_NOTES="$RELEASE_NOTES" python3 -c '
import json, os
release = {
  "name": os.environ["RELEASE_NAME"],
  "status": os.environ["RELEASE_STATUS"],
  "versionCodes": [os.environ["VERSION_CODE"]],
}
notes = os.environ.get("RELEASE_NOTES", "").strip()
if notes:
  release["releaseNotes"] = [{"language": "en-US", "text": notes}]
print(json.dumps({"track": os.environ["TRACK"], "releases": [release]}))
')

api PUT "$API/edits/$edit_id/tracks/$TRACK" \
  -H "Content-Type: application/json" \
  --data "$track_body" > /dev/null
echo "  track release configured"

echo "4/4 Committing edit..."
api POST "$API/edits/$edit_id:commit" -H "Content-Length: 0" > /dev/null
echo "  edit committed — versionCode $version_code is on the $TRACK track as $RELEASE_STATUS"
echo ""
echo "Play Console: $(play_console_url)"
echo "  open the app → Testing → ${TRACK} to see release $RELEASE_NAME"
