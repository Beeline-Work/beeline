#!/usr/bin/env bash
# Build the canonical helper archive from this release before building its VM image.
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
export BEELINE_BUNDLE_COMMIT=${BEELINE_RELEASE_SHA:-$(git -C "$root" rev-parse HEAD)}
export BEELINE_BUNDLE_VERSION=${BEELINE_RELEASE_VERSION:?release version is required}
export CARGO_BUILD_JOBS=${CARGO_BUILD_JOBS:-2}
cd "$root"
npm run bundle:beeline -- --platform linux-x64
target=infra/free-agent/helper-bundle
mkdir -p "$target"
for file in manifest.json beeline-linux-x64.tar.gz beeline-linux-x64.tar.gz.sha256 beeline-bootstrap.mjs; do
  cp "relay-stack/web/dl/$file" "$target/$file"
done
