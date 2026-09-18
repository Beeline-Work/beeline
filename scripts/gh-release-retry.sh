#!/usr/bin/env bash
# Bounded-retry, verification wrappers for the GitHub CLI calls the unified
# release's `release_result` job makes (run 35268976983: a transient GitHub
# `HTTP 500: Error saving asset` on `gh release upload` failed an otherwise
# finished release). The release must be deterministic and not brittle:
#
# - every upload/create/delete-asset/api call is retried up to
#   GHR_MAX_ATTEMPTS (default 5) with exponential backoff 5s..80s;
# - an upload counts as succeeded only when a follow-up `gh release view
#   --json assets` finds every uploaded asset present with matching size —
#   the exit code alone has already lied to us once;
# - `gh release create` recovers a PARTIAL create (release published, then an
#   asset upload inside the same command failed) by clobbering the missing
#   assets onto the now-existing release instead of retrying create itself,
#   which would fail permanently with "already exists";
# - uploads use --clobber, so re-running a release_result step over assets
#   that already exist with identical bytes is idempotent.
#
# Sourced by .github/workflows/unified-release.yml's release_result job.
# The rollback trap and manifest-commit-point semantics of that job are
# unchanged: these wrappers fail (nonzero) only when every attempt failed,
# exactly like the bare calls they replace.

# Test hooks: the backoff schedule and attempt cap are overridable so the
# unit tests (scripts/gh-release-retry.test.mjs) run in milliseconds.
GHR_MAX_ATTEMPTS="${GHR_MAX_ATTEMPTS:-5}"
read -r -a GHR_BACKOFF <<< "${GHR_BACKOFF_SECONDS:-5 10 20 40}"

ghr_backoff_delay() {
  local attempt="$1"
  local delay="${GHR_BACKOFF[$((attempt - 1))]:-${GHR_BACKOFF[${#GHR_BACKOFF[@]} - 1]}}"
  printf '%s' "${delay:-80}"
}

ghr_sleep_backoff() {
  sleep "$(ghr_backoff_delay "$1")"
}

ghr_exhausted() {
  echo "gh $1 failed after $GHR_MAX_ATTEMPTS attempts; giving up" >&2
}

# ghr_api <gh api args...>
# Plain bounded retry; no verification is possible for an arbitrary endpoint.
ghr_api() {
  local attempt=1
  while :; do
    if gh api "$@"; then
      return 0
    fi
    if [ "$attempt" -ge "$GHR_MAX_ATTEMPTS" ]; then
      ghr_exhausted "api $*"
      return 1
    fi
    ghr_sleep_backoff "$attempt"
    attempt=$((attempt + 1))
  done
}

# ghr_assets_present <release> <file[#remote-name]...>
# Succeeds only when every named asset is on the release with matching size.
ghr_assets_present() {
  local release="$1"
  shift
  local listing file local_name expected_name local_size remote_size
  listing=$(gh release view "$release" --json assets --jq '.assets[] | "\(.name)\t\(.size)"') || return 1
  for file in "$@"; do
    # `file#label` only sets a display label; the asset NAME is always the
    # local file's basename.
    local_name="${file%%#*}"
    expected_name=$(basename "$local_name")
    local_size=$(wc -c < "$local_name") || return 1
    remote_size=$(printf '%s\n' "$listing" | awk -F'\t' -v name="$expected_name" '$1 == name { print $2; found = 1 } END { if (!found) exit 1 }') || return 1
    if [ "$local_size" -ne "$remote_size" ]; then
      echo "asset $expected_name on $release has $remote_size bytes, local $local_name has $local_size" >&2
      return 1
    fi
  done
}

# ghr_upload_verified <release> <file[#remote-name]...>
# `gh release upload ... --clobber` behind a bounded retry, each success
# confirmed by listing the release's assets (name + byte size).
ghr_upload_verified() {
  local release="$1"
  shift
  [ "$#" -gt 0 ] || return 0
  local attempt=1
  while :; do
    if gh release upload "$release" "$@" --clobber; then
      if ghr_assets_present "$release" "$@"; then
        return 0
      fi
      echo "gh release upload exited 0 but $release does not list every asset with matching bytes; retrying" >&2
    fi
    if [ "$attempt" -ge "$GHR_MAX_ATTEMPTS" ]; then
      ghr_exhausted "release upload to $release"
      return 1
    fi
    ghr_sleep_backoff "$attempt"
    attempt=$((attempt + 1))
  done
}

# ghr_create <release> <gh release create args...>
# Bounded retry around `gh release create`. A failed attempt may have
# published the release and then failed one of its asset uploads (the
# GitHub-side HTTP 500 in run 35268976983); when the release exists after a
# failed attempt, the positional asset files are clobbered onto it and the
# create counts as complete. Flag VALUES (--target/--title/--notes-file/…)
# are skipped when collecting those files so a notes file is never uploaded
# as an asset.
ghr_create() {
  local release="$1"
  shift
  local attempt=1
  while :; do
    if gh release create "$release" "$@"; then
      return 0
    fi
    if gh release view "$release" >/dev/null 2>&1; then
      local -a files=()
      local arg skip_next=false
      for arg in "$@"; do
        if [ "$skip_next" = true ]; then
          skip_next=false
          continue
        fi
        case "$arg" in
          --target | --title | --notes | --notes-file | --discussion-category) skip_next=true; continue ;;
        esac
        if [ -f "$arg" ]; then
          files+=("$arg")
        fi
      done
      if [ "${#files[@]}" -eq 0 ] || ghr_upload_verified "$release" "${files[@]}"; then
        return 0
      fi
    fi
    if [ "$attempt" -ge "$GHR_MAX_ATTEMPTS" ]; then
      ghr_exhausted "release create $release"
      return 1
    fi
    ghr_sleep_backoff "$attempt"
    attempt=$((attempt + 1))
  done
}

# ghr_delete_asset <release> <asset-name>
# Bounded retry around `gh release delete-asset --yes`. Callers keep `|| true`
# where deletion is best-effort, unchanged.
ghr_delete_asset() {
  local release="$1"
  local asset="$2"
  local attempt=1
  while :; do
    if gh release delete-asset "$release" "$asset" --yes; then
      return 0
    fi
    if [ "$attempt" -ge "$GHR_MAX_ATTEMPTS" ]; then
      ghr_exhausted "release delete-asset $asset from $release"
      return 1
    fi
    ghr_sleep_backoff "$attempt"
    attempt=$((attempt + 1))
  done
}
