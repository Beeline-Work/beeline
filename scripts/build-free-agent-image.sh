#!/usr/bin/env bash
# Build (and optionally push) the free starter agent base image from the
# repository root, using the same source context as the release.
#   scripts/build-free-agent-image.sh <image-ref> [--push]
set -euo pipefail
image=${1:?usage: build-free-agent-image.sh <image-ref> [--push]}
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
release_sha=$(git -C "$root" rev-parse HEAD)
release_version=${BEELINE_RELEASE_VERSION:-development}
BEELINE_RELEASE_SHA="$release_sha" BEELINE_RELEASE_VERSION="$release_version" \
  bash "$root/scripts/stage-free-agent-helper.sh"
docker build --platform linux/amd64 -f "$root/infra/free-agent/Dockerfile" \
  --build-arg "BEELINE_RELEASE_SHA=$release_sha" \
  --build-arg "BEELINE_RELEASE_VERSION=$release_version" -t "$image" "$root"
if [ "${2:-}" = --push ]; then docker push "$image"; fi
