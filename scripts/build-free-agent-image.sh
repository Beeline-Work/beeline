#!/usr/bin/env bash
# Build (and optionally push) the free starter agent base image from the
# repository root, the same context the release uses (`.dockerignore` admits
# only infra/free-agent and the published installer).
#   scripts/build-free-agent-image.sh <image-ref> [--push]
set -euo pipefail
image=${1:?usage: build-free-agent-image.sh <image-ref> [--push]}
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
docker build --platform linux/amd64 -f "$root/infra/free-agent/Dockerfile" -t "$image" "$root"
if [ "${2:-}" = --push ]; then docker push "$image"; fi
