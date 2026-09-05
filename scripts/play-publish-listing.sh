#!/usr/bin/env bash
#
# Push the Play store listing (title, descriptions, icon, feature graphic,
# phone screenshots) from the committed fastlane metadata dir through the
# AndroidPublisher REST API. Called from the store_android job of
# .github/workflows/unified-release.yml.
#
# Separate from the AAB upload because listing edits are rare (a copy pass, a
# new screenshot) and must not ride along with every build.
#
# Required environment:
#   ACCESS_TOKEN     — OAuth access token with the androidpublisher scope
#   PACKAGE_NAME     — app.usebeeline
#   METADATA_DIR     — path to apps/mobile/fastlane/metadata/android (the parent
#                      of the per-locale dirs such as en-US/)
#   LANGUAGE         — locale code, e.g. en-US
# Optional:
#   PLAY_DRY_RUN=1   — print the API calls instead of making them (see play-api.sh)
#
# Everything lands in ONE Play Console edit that is validated and committed at
# the end; nothing partial survives a failure. Track releases are a separate
# dimension and are untouched.

set -euo pipefail

# shellcheck source=scripts/play-api.sh
source "$(dirname "${BASH_SOURCE[0]}")/play-api.sh"

: "${METADATA_DIR:?METADATA_DIR env var is required (path to apps/mobile/fastlane/metadata/android)}"
: "${LANGUAGE:?LANGUAGE env var is required (e.g. en-US)}"

LOCALE_DIR="$METADATA_DIR/$LANGUAGE"
IMAGES_DIR="$LOCALE_DIR/images"

for required in "$LOCALE_DIR/title.txt" "$LOCALE_DIR/short_description.txt" \
                "$LOCALE_DIR/full_description.txt" "$IMAGES_DIR/icon.png" \
                "$IMAGES_DIR/featureGraphic.png"; do
  if [ ! -f "$required" ]; then
    echo "::error::missing required listing asset: $required" >&2
    exit 1
  fi
done

echo "▸ Creating edit"
EDIT_ID=$(api POST "$API/edits" -H 'Content-Type: application/json' -d '{}' | json_field id)
echo "  editId = $EDIT_ID"

echo "▸ Updating listing text ($LANGUAGE)"
TITLE=$(cat "$LOCALE_DIR/title.txt")
SHORT=$(cat "$LOCALE_DIR/short_description.txt")
FULL=$(cat "$LOCALE_DIR/full_description.txt")

# python builds the JSON so quotes, dashes and newlines in the copy survive.
LISTING_JSON=$(LISTING_LANGUAGE="$LANGUAGE" TITLE="$TITLE" SHORT="$SHORT" FULL="$FULL" \
  python3 -c '
import json, os
print(json.dumps({
    "language": os.environ["LISTING_LANGUAGE"],
    "title": os.environ["TITLE"].rstrip("\n"),
    "shortDescription": os.environ["SHORT"].rstrip("\n"),
    "fullDescription": os.environ["FULL"].rstrip("\n"),
}))')

api PUT "$API/edits/$EDIT_ID/listings/$LANGUAGE" \
    -H 'Content-Type: application/json' \
    -d "$LISTING_JSON" >/dev/null
echo "  title=${#TITLE} chars / short=${#SHORT} / full=${#FULL}"

# The API appends images; clear each image type first so stale assets do not
# accumulate in Play Console.
upload_image() {
  local type="$1" path="$2"
  local ct="image/png"
  case "$path" in *.jpg|*.jpeg) ct="image/jpeg" ;; esac
  echo "  ↑ $type ← $(basename "$path") ($ct)"
  api POST "$UPLOAD_API/edits/$EDIT_ID/listings/$LANGUAGE/$type?uploadType=media" \
      -H "Content-Type: $ct" \
      --data-binary "@$path" >/dev/null
}

clear_image_set() {
  local type="$1"
  api DELETE "$API/edits/$EDIT_ID/listings/$LANGUAGE/$type" >/dev/null
}

echo "▸ Uploading icon"
clear_image_set icon
upload_image icon "$IMAGES_DIR/icon.png"

echo "▸ Uploading feature graphic"
clear_image_set featureGraphic
upload_image featureGraphic "$IMAGES_DIR/featureGraphic.png"

echo "▸ Uploading phone screenshots"
clear_image_set phoneScreenshots
# Filename order is carousel order; Play keeps upload order within a type.
shots=()
for shot in "$IMAGES_DIR"/phoneScreenshots/*.png "$IMAGES_DIR"/phoneScreenshots/*.jpg; do
  [ -f "$shot" ] && shots+=("$shot")
done
if [ "${#shots[@]}" -eq 0 ]; then
  echo "::error::no phone screenshots in $IMAGES_DIR/phoneScreenshots" >&2
  exit 1
fi
while IFS= read -r shot; do
  upload_image phoneScreenshots "$shot"
done < <(printf '%s\n' "${shots[@]}" | sort)

echo "▸ Validating edit"
api POST "$API/edits/$EDIT_ID:validate" -H "Content-Length: 0" >/dev/null
echo "  ok"

echo "▸ Committing edit"
api POST "$API/edits/$EDIT_ID:commit" -H "Content-Length: 0" >/dev/null
echo "  Listing updates are live in Play Console."
echo ""
echo "What changed ($LANGUAGE): title, short description, full description,"
echo "icon (512×512), feature graphic (1024×500), ${#shots[@]} phone screenshots."
echo "Track releases are unaffected — this script only edits the store listing."
echo ""
echo "Play Console: $(play_console_url)"
