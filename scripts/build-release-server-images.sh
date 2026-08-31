#!/usr/bin/env bash
set -euo pipefail

RELEASE_VERSION=${BEELINE_RELEASE_VERSION:?set BEELINE_RELEASE_VERSION to vX.Y.Z}
RELEASE_SHA=${BEELINE_RELEASE_SHA:?set BEELINE_RELEASE_SHA to the full main sha}

[[ $RELEASE_VERSION =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
  echo "invalid Beeline release version: $RELEASE_VERSION" >&2
  exit 1
}
[[ $RELEASE_SHA =~ ^[0-9a-f]{40}$ ]] || {
  echo "invalid Beeline release sha: $RELEASE_SHA" >&2
  exit 1
}
test "$(git rev-parse HEAD)" = "$RELEASE_SHA" || {
  echo "checkout does not match Beeline release sha: $RELEASE_SHA" >&2
  exit 1
}

build_image() {
  local name=$1 dockerfile=$2
  docker build \
    --build-arg "BEELINE_RELEASE_VERSION=$RELEASE_VERSION" \
    --build-arg "BEELINE_RELEASE_SHA=$RELEASE_SHA" \
    -f "$dockerfile" \
    -t "$name:release-$RELEASE_SHA" \
    .
  test "$(docker image inspect --format '{{ index .Config.Labels "app.usebeeline.release.version" }}' "$name:release-$RELEASE_SHA")" = "$RELEASE_VERSION"
  test "$(docker image inspect --format '{{ index .Config.Labels "app.usebeeline.release.sha" }}' "$name:release-$RELEASE_SHA")" = "$RELEASE_SHA"
}

build_image beeline-auth apps/auth/Dockerfile
build_image beeline-materializer apps/push-gateway/Dockerfile
echo "server artifacts built for $RELEASE_VERSION ($RELEASE_SHA)"
