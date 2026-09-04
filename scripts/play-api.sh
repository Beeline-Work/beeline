#!/usr/bin/env bash
#
# Shared AndroidPublisher REST helper for scripts/play-publish.sh,
# scripts/play-publish-listing.sh and scripts/play-promote-track.sh.
# Source it; do not run it.
#
# Why curl + REST instead of `fastlane supply` or `eas submit`: the workflow
# already holds a short-lived OAuth access token from google-github-actions/auth,
# the REST API takes it directly, and every step's response body is printed on
# failure so a rejected call names itself.
#
# Required environment (unless PLAY_DRY_RUN=1):
#   ACCESS_TOKEN — OAuth access token with the androidpublisher scope
#   PACKAGE_NAME — e.g. app.usebeeline.mobile
#
# PLAY_DRY_RUN=1 makes `api` print every call it would make (method, URL, and
# the curl arguments minus the bearer token) and answer with a canned body, so
# the sequence can be proven without a service account.
# PLAY_DRY_RUN_VERSION_CODE sets the versionCode the canned upload/track bodies
# report (default 0).

: "${PACKAGE_NAME:?PACKAGE_NAME env var is required (e.g. app.usebeeline.mobile)}"
if [ "${PLAY_DRY_RUN:-0}" != "1" ]; then
  : "${ACCESS_TOKEN:?ACCESS_TOKEN env var is required (androidpublisher OAuth access token)}"
fi

API="https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PACKAGE_NAME}"
UPLOAD_API="https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications/${PACKAGE_NAME}"
export API UPLOAD_API

play_dry_run_response() {
  local method="$1" url="$2"
  local version_code="${PLAY_DRY_RUN_VERSION_CODE:-0}"
  case "$method $url" in
    "POST $API/edits") echo '{"id":"dry-run-edit"}' ;;
    "POST $UPLOAD_API/edits/"*"/bundles?"*) echo "{\"versionCode\":${version_code}}" ;;
    "GET $API/edits/"*"/tracks/"*)
      echo "{\"track\":\"${url##*/}\",\"releases\":[{\"name\":\"dry-run-release\",\"status\":\"completed\",\"versionCodes\":[\"${version_code}\"],\"releaseNotes\":[{\"language\":\"en-US\",\"text\":\"dry-run notes\"}]}]}"
      ;;
    *) echo '{}' ;;
  esac
}

# api METHOD URL [curl args...]  — prints the response body; a non-2xx status
# prints the body to stderr and returns 1 so `set -e` stops the script.
api() {
  local method="$1" url="$2"
  shift 2
  if [ "${PLAY_DRY_RUN:-0}" = "1" ]; then
    echo "DRY-RUN $method $url${*:+ $*}" >&2
    play_dry_run_response "$method" "$url"
    return 0
  fi
  local body status
  body=$(curl -sS -w "\n%{http_code}" -X "$method" "$url" -H "Authorization: Bearer ${ACCESS_TOKEN}" "$@")
  status=$(echo "$body" | tail -n1)
  body=$(echo "$body" | sed '$d')
  if [ "$status" -lt 200 ] || [ "$status" -ge 300 ]; then
    echo "::error::API call failed: $method $url → HTTP $status" >&2
    echo "$body" >&2
    return 1
  fi
  echo "$body"
}

json_field() {
  python3 -c 'import json, sys; print(json.load(sys.stdin)[sys.argv[1]])' "$1"
}

play_console_url() {
  echo "https://play.google.com/console/u/0/developers/-/app-list?search=${PACKAGE_NAME}"
}
