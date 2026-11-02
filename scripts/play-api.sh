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

# commit_edit EDIT_ID [send-for-review] — builds must enter review automatically.
# Build and explicitly authorized listing publishers use the protected mode.
commit_edit() {
  local edit_id="$1"
  if [ "${2:-}" = "send-for-review" ]; then
    # Preserve an existing review rather than cancelling it. Never fall back to
    # saving an unsent build: a refusal must fail the release.
    api POST "$API/edits/$edit_id:commit?changesInReviewBehavior=ERROR_IF_IN_REVIEW" -H "Content-Length: 0" >/dev/null
    echo "Build sent for review; full rollout follows approval."
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
