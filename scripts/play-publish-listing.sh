#!/usr/bin/env bash
#
# Push the Play store listing (title, descriptions, icon, feature graphic,
# phone screenshots) from the committed fastlane metadata dir through the
# AndroidPublisher REST API. Called from the store_android job of
# .github/workflows/unified-release.yml.
#
# The bundle upload is a separate script. This one reads the listing Play
# already has and skips the upload when the committed text and image hashes
# match, so a normal build is not reviewed as a store-listing change.
#
# Required environment:
#   ACCESS_TOKEN     — OAuth access token with the androidpublisher scope
#   PACKAGE_NAME     — app.usebeeline
#   METADATA_DIR     — path to apps/mobile/fastlane/metadata/android (the parent
#                      of the per-locale dirs such as en-US/)
#   LANGUAGE         — locale code, e.g. en-US
# Optional:
#   PLAY_DRY_RUN=1   — print the API calls instead of making them (see play-api.sh)
#   PLAY_REMOTE_LISTING — dry-run only: JSON file of the listing Play would
#                      return. When it matches the files, no edit is created.
#   FORCE_LISTING=1  — upload even when the listing already matches
#   PLAY_LISTING_CHECK_ONLY=1 — compare and delete the read edit; never upload

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

shots=()
for shot in "$IMAGES_DIR"/phoneScreenshots/*.png "$IMAGES_DIR"/phoneScreenshots/*.jpg; do
  [ -f "$shot" ] && shots+=("$shot")
done
if [ "${#shots[@]}" -eq 0 ]; then
  echo "::error::no phone screenshots in $IMAGES_DIR/phoneScreenshots" >&2
  exit 1
fi
mapfile -t shots < <(printf '%s\n' "${shots[@]}" | sort)

flag_on() {
  case "${1:-}" in
    1|true|TRUE|yes|YES) return 0 ;;
    *) return 1 ;;
  esac
}

WORK=$(mktemp -d)
EDIT_ID=""
differs=""
cleanup() {
  local status=$?
  if [ -n "$EDIT_ID" ]; then
    api DELETE "$API/edits/$EDIT_ID" >/dev/null || true
    EDIT_ID=""
  fi
  rm -rf "$WORK"
  exit "$status"
}
trap cleanup EXIT

skip_listing() {
  if [ -n "$EDIT_ID" ]; then
    echo "▸ Discarding the read-only edit"
    api DELETE "$API/edits/$EDIT_ID" >/dev/null
    EDIT_ID=""
  fi
  echo "Store listing unchanged; skipped"
  if [ -f "$WORK/hash-field" ]; then
    echo "  Image hash field: $(cat "$WORK/hash-field")"
  fi
  exit 0
}

# Compare committed files with a Play-shaped snapshot:
# {listing, icon, featureGraphic, phoneScreenshots}. Exit 0 when every
# text field and image hash matches. Image hashes may be sha256 or sha1,
# hex or base64.
compare_or_skip() {
  local result status
  set +e
  result=$(LISTING_HASH_NOTE="$WORK/hash-field" python3 - "$1" \
    "$LOCALE_DIR/title.txt" "$LOCALE_DIR/short_description.txt" \
    "$LOCALE_DIR/full_description.txt" "$IMAGES_DIR/icon.png" \
    "$IMAGES_DIR/featureGraphic.png" "${shots[@]}" <<'PY'
import base64, hashlib, json, os, sys
from pathlib import Path

remote_path = Path(sys.argv[1])
title_path, short_path, full_path, icon_path, feature_path = map(Path, sys.argv[2:7])
shot_paths = [Path(item) for item in sys.argv[7:]]

def norm(value):
    if not isinstance(value, str):
        return None
    return value.rstrip('\n')

def forms(data):
    out = set()
    for digest in (hashlib.sha256(data).digest(), hashlib.sha1(data).digest()):
        hex_lower = digest.hex()
        out.add(hex_lower)
        out.add(hex_lower.upper())
        for encoded in (base64.b64encode(digest), base64.urlsafe_b64encode(digest)):
            text = encoded.decode('ascii')
            out.add(text)
            out.add(text.rstrip('='))
    return out

def image_ok(obj, path):
    if not isinstance(obj, dict):
        return False, ''
    wanted = forms(path.read_bytes())
    for field in ('sha256', 'sha1'):
        value = obj.get(field)
        if isinstance(value, str) and value.strip() in wanted:
            return True, field
    return False, ''

def images_of(node):
    if not isinstance(node, dict):
        return None
    images = node.get('images', [])
    if images is None:
        images = []
    return images if isinstance(images, list) else None

try:
    remote = json.loads(remote_path.read_text())
except (OSError, json.JSONDecodeError) as error:
    print(f'unreadable remote listing: {error}', file=sys.stderr)
    sys.exit(2)
if not isinstance(remote, dict):
    print('remote listing is not an object', file=sys.stderr)
    sys.exit(2)

diffs = []
fields = []
listing = remote.get('listing')
if not isinstance(listing, dict):
    diffs.append('listing')
else:
    local_text = {
        'title': norm(title_path.read_text()),
        'shortDescription': norm(short_path.read_text()),
        'fullDescription': norm(full_path.read_text()),
    }
    for key, local in local_text.items():
        if norm(listing.get(key)) != local:
            diffs.append(key)

def one_image(key, path):
    images = images_of(remote.get(key))
    if images is None or len(images) != 1:
        diffs.append(key)
        return
    ok, field = image_ok(images[0], path)
    if not ok:
        diffs.append(key)
    elif field:
        fields.append(field)

one_image('icon', icon_path)
one_image('featureGraphic', feature_path)
shot_images = images_of(remote.get('phoneScreenshots'))
if shot_images is None or len(shot_images) != len(shot_paths):
    diffs.append('phoneScreenshots')
else:
    shot_failed = False
    for image, path in zip(shot_images, shot_paths):
        ok, field = image_ok(image, path)
        if not ok:
            shot_failed = True
            break
        if field:
            fields.append(field)
    if shot_failed:
        diffs.append('phoneScreenshots')

if diffs:
    print('differ ' + ' '.join(diffs))
    sys.exit(1)
note = os.environ.get('LISTING_HASH_NOTE', '')
if note and fields:
    Path(note).write_text(' '.join(sorted(set(fields))))
PY
)
  status=$?
  set -e
  if [ "$status" -eq 0 ]; then
    skip_listing
  elif [ "$status" -eq 1 ] && [[ "$result" == differ* ]]; then
    differs=$result
    return 0
  fi
  echo "::error::could not compare the store listing" >&2
  printf '%s\n' "$result" >&2
  exit 1
}

read_play_listing() {
  echo "▸ Reading the Play listing"
  EDIT_ID=$(api POST "$API/edits" -H 'Content-Type: application/json' -d '{}' | json_field id)
  echo "  editId = $EDIT_ID"
  api GET "$API/edits/$EDIT_ID/listings/$LANGUAGE" > "$WORK/listing.json"
  api GET "$API/edits/$EDIT_ID/listings/$LANGUAGE/icon" > "$WORK/icon.json"
  api GET "$API/edits/$EDIT_ID/listings/$LANGUAGE/featureGraphic" > "$WORK/feature.json"
  api GET "$API/edits/$EDIT_ID/listings/$LANGUAGE/phoneScreenshots" > "$WORK/shots.json"
  python3 - "$WORK/listing.json" "$WORK/icon.json" "$WORK/feature.json" "$WORK/shots.json" "$WORK/remote.json" <<'PY'
import json, sys
listing, icon, feature, shots, out = sys.argv[1:]
def load(path):
    with open(path) as handle:
        text = handle.read().strip()
    return json.loads(text or '{}')
with open(out, 'w') as handle:
    json.dump({
        'listing': load(listing),
        'icon': load(icon),
        'featureGraphic': load(feature),
        'phoneScreenshots': load(shots),
    }, handle)
PY
  compare_or_skip "$WORK/remote.json"
}

if flag_on "${FORCE_LISTING:-}" && ! flag_on "${PLAY_LISTING_CHECK_ONLY:-}"; then
  echo "FORCE_LISTING=1; pushing the store listing"
elif [ "${PLAY_DRY_RUN:-0}" = "1" ] && [ -n "${PLAY_REMOTE_LISTING:-}" ]; then
  compare_or_skip "$PLAY_REMOTE_LISTING"
elif [ "${PLAY_DRY_RUN:-0}" != "1" ]; then
  read_play_listing
elif flag_on "${PLAY_LISTING_CHECK_ONLY:-}"; then
  echo "::error::PLAY_LISTING_CHECK_ONLY needs PLAY_REMOTE_LISTING when PLAY_DRY_RUN=1" >&2
  exit 1
fi

if flag_on "${PLAY_LISTING_CHECK_ONLY:-}"; then
  echo "Store listing differs: ${differs:-unknown}; not uploaded (publish_listing is false)"
  exit 2
fi
if [ -n "$differs" ]; then
  echo "▸ Store listing differs ($differs); uploading"
fi

if [ -z "$EDIT_ID" ]; then
  echo "▸ Creating edit"
  EDIT_ID=$(api POST "$API/edits" -H 'Content-Type: application/json' -d '{}' | json_field id)
  echo "  editId = $EDIT_ID"
fi

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
while IFS= read -r shot; do
  upload_image phoneScreenshots "$shot"
done < <(printf '%s\n' "${shots[@]}")

# No separate :validate call: Play rejects validate with "Changes cannot be sent
# for review automatically" for this app even though the commit below carries
# changesNotSentForReview=true (validate has no such parameter), and commit
# validates the edit itself before applying it.
echo "▸ Committing edit"
commit_edit "$EDIT_ID"
EDIT_ID=""
echo "  Listing updates are live in Play Console."
echo ""
echo "What changed ($LANGUAGE): title, short description, full description,"
echo "icon (512×512), feature graphic (1024×500), ${#shots[@]} phone screenshots."
echo "Track releases are unaffected — this script only edits the store listing."
echo ""
echo "Play Console: $(play_console_url)"
