#!/usr/bin/env bash
#
# Shared AndroidPublisher REST helper for scripts/play-publish.sh,
# scripts/play-publish-listing.sh and scripts/play-promote-track.sh.
# Source it; do not run it.
#
# Why curl + REST instead of `fastlane supply` or `eas submit`: the workflow
# already holds a short-lived OAuth access token from scripts/play-token.mjs,
# the REST API takes it directly, and every step's response body is printed on
# failure so a rejected call names itself.
#
# Required environment (unless PLAY_DRY_RUN=1):
#   ACCESS_TOKEN — OAuth access token with the androidpublisher scope
#   PACKAGE_NAME — e.g. app.usebeeline
#
# PLAY_DRY_RUN=1 makes `api` print every call it would make (method, URL, and
# the curl arguments minus the bearer token) and answer with a canned body, so
# the sequence can be proven without a service account.
# PLAY_DRY_RUN_VERSION_CODE sets the versionCode the canned upload/track bodies
# report (default 0). PLAY_DRY_RUN_TRACKS is the canned edits.tracks.list body
# (default: no tracks).

: "${PACKAGE_NAME:?PACKAGE_NAME env var is required (e.g. app.usebeeline)}"
if [ "${PLAY_DRY_RUN:-0}" != "1" ]; then
  : "${ACCESS_TOKEN:?ACCESS_TOKEN env var is required (androidpublisher OAuth access token)}"
fi

API="https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PACKAGE_NAME}"
UPLOAD_API="https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications/${PACKAGE_NAME}"
export API UPLOAD_API

play_dry_run_response() {
  local method="$1" url="$2"
  local version_code="${PLAY_DRY_RUN_VERSION_CODE:-0}" no_tracks='{"tracks":[]}'
  case "$method $url" in
    "POST $API/edits") echo '{"id":"dry-run-edit"}' ;;
    "POST $UPLOAD_API/edits/"*"/bundles?"*) echo "{\"versionCode\":${version_code}}" ;;
    "GET $API/edits/"*"/tracks") echo "${PLAY_DRY_RUN_TRACKS:-$no_tracks}" ;;
    "GET $API/edits/"*"/tracks/"*)
      echo "{\"track\":\"${url##*/}\",\"releases\":[{\"name\":\"dry-run-release\",\"status\":\"completed\",\"versionCodes\":[\"${version_code}\"],\"releaseNotes\":[{\"language\":\"en-US\",\"text\":\"dry-run notes\"}]}]}"
      ;;
    *) echo '{}' ;;
  esac
}

# api METHOD URL [curl args...]  — prints the response body; a non-2xx status
# prints the body to stderr and returns 1 so `set -e` stops the script.
#
# Transient Play failures (HTTP 5xx and 429) are retried up to 3 times with
# backoff, because short Google outages must not fail a release. Other 4xx
# responses are real refusals and fail at once. PLAY_RETRY_DELAYS overrides
# the backoff delays (default "5 15 45"), mainly for tests.
api() {
  local method="$1" url="$2"
  shift 2
  if [ "${PLAY_DRY_RUN:-0}" = "1" ]; then
    echo "DRY-RUN $method $url${*:+ $*}" >&2
    play_dry_run_response "$method" "$url"
    return 0
  fi
  local delays body status attempt
  read -ra delays <<< "${PLAY_RETRY_DELAYS:-5 15 45}"
  for attempt in 1 2 3 4; do
    body=$(curl -sS -w "\n%{http_code}" -X "$method" "$url" -H "Authorization: Bearer ${ACCESS_TOKEN}" "$@")
    status=$(echo "$body" | tail -n1)
    body=$(echo "$body" | sed '$d')
    if [[ "$status" =~ ^[0-9]{3}$ ]] && [ "$status" -ge 200 ] && [ "$status" -lt 300 ]; then
      echo "$body"
      return 0
    fi
    if [[ "$status" =~ ^[0-9]{3}$ ]] && { [ "$status" -ge 500 ] || [ "$status" = 429 ]; } && [ "$attempt" -le "${#delays[@]}" ]; then
      echo "  Play returned HTTP $status; retrying in ${delays[$((attempt-1))]}s (retry $attempt of 3)" >&2
      sleep "${delays[$((attempt-1))]}"
      continue
    fi
    echo "::error::API call failed: $method $url → HTTP $status" >&2
    echo "$body" >&2
    return 1
  done
}

json_field() {
  python3 -c 'import json, sys; print(json.load(sys.stdin)[sys.argv[1]])' "$1"
}

play_console_url() {
  echo "https://play.google.com/console/u/0/developers/-/app-list?search=${PACKAGE_NAME}"
}

# commit_edit EDIT_ID [hold-for-review] — keep default builds unsent;
# other callers retain the existing adaptive commit behavior.
# Google toggles the required form of this call on the app's current state:
# while an unsent/rejected change is pending, `:commit` must carry
# `changesNotSentForReview=true` ("Changes cannot be sent for review
# automatically. Please set the query parameter changesNotSentForReview to
# true"); once changes are sent for review automatically, the same parameter
# must NOT be set ("Changes are sent for review automatically. The query
# parameter changesNotSentForReview must not be set."). Runs 34875518794 and
# 34885345563 hit one each on the same day. Try the flagged form first and fall
# back to the plain commit only on that exact complaint.
commit_edit() {
  local edit_id="$1"
  # Default build releases cannot safely detect console listing changes. Never
  # retry without the hold flag, or cancel an existing review, in this mode.
  # https://developers.google.com/android-publisher/concurrency-considerations
  # https://developers.google.com/android-publisher/api-ref/rest/v3/edits/commit
  if [ "${2:-}" = "hold-for-review" ]; then
    if ! api POST "$API/edits/$edit_id:commit?changesNotSentForReview=true&changesInReviewBehavior=ERROR_IF_IN_REVIEW" -H "Content-Length: 0" >/dev/null; then
      echo "::error::Play refused the safe commit; no automatic-review fallback attempted. Finish the build submission alone in Play Console." >&2
      return 1
    fi
    echo "Build uploaded but not sent for review; send the build alone in Play Console and keep listing changes saved for later."
    return 0
  fi
  if [ "${PLAY_DRY_RUN:-0}" = "1" ]; then
    api POST "$API/edits/$edit_id:commit?changesNotSentForReview=true" -H "Content-Length: 0" >/dev/null
    return 0
  fi
  local body status
  body=$(curl -sS -w "\n%{http_code}" -X POST "$API/edits/$edit_id:commit?changesNotSentForReview=true" \
    -H "Authorization: Bearer ${ACCESS_TOKEN}" -H "Content-Length: 0")
  status=$(echo "$body" | tail -n1)
  body=$(echo "$body" | sed '$d')
  if [ "$status" -ge 200 ] && [ "$status" -lt 300 ]; then return 0; fi
  if [ "$status" = 400 ] && echo "$body" | grep -q "changesNotSentForReview must not be set"; then
    echo "  Play reports changes are sent for review automatically; committing without changesNotSentForReview"
    api POST "$API/edits/$edit_id:commit" -H "Content-Length: 0" >/dev/null
    return 0
  fi
  echo "::error::API call failed: POST $API/edits/$edit_id:commit?changesNotSentForReview=true → HTTP $status" >&2
  echo "$body" >&2
  return 1
}
