#!/usr/bin/env bash
# Registry images are build outputs, never release memory. A prebuild may be
# absent or fail; release then builds from source with the same Dockerfile.
set -euo pipefail

mode="${1:?expected prebuild or release}"
sha="${2:?expected full source SHA}"
version="${3:-development}"
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { echo 'invalid server source SHA' >&2; exit 1; }
test "$(git rev-parse HEAD)" = "$sha"
source_image="registry.fly.io/beeline-server:source-$sha"
flyctl auth docker

if [ "$mode" = prebuild ]; then
  flyctl deploy . --local-only --config fly.beeline-server.toml \
    --dockerfile apps/server/Dockerfile --app beeline-server \
    --build-arg BEELINE_RELEASE_VERSION=development --build-arg "BEELINE_RELEASE_SHA=$sha" \
    --image-label "source-$sha" --build-only --push --yes
elif [ "$mode" = release ]; then
  [[ "$version" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo 'invalid server release version' >&2; exit 1; }
  label="${version#v}-${sha:0:12}"
  release_image="registry.fly.io/beeline-server:$label"
  if docker pull "$source_image"; then
    actual_sha=$(docker image inspect --format '{{ index .Config.Labels "app.usebeeline.release.sha" }}' "$source_image")
    test "$actual_sha" = "$sha" || { echo 'prebuilt server image source SHA mismatch' >&2; exit 1; }
    # Pin the bytes we inspected. Only identity metadata changes at release;
    # source, compiled packages and dependencies are exactly the prebuilt image.
    source_digest=$(docker image inspect --format '{{ index .RepoDigests 0 }}' "$source_image")
    [[ "$source_digest" =~ ^registry\.fly\.io/beeline-server@sha256:[0-9a-f]{64}$ ]] || {
      echo 'prebuilt server image has no immutable registry digest' >&2; exit 1;
    }
    docker build --pull=false --tag "$release_image" --file - . <<EOF
FROM $source_digest
ENV BEELINE_RELEASE_VERSION=$version BEELINE_RELEASE_SHA=$sha
LABEL app.usebeeline.release.version=$version app.usebeeline.release.sha=$sha
EOF
    docker push "$release_image"
  else
    echo 'No prebuilt server image available; building the exact release from source.'
    flyctl deploy . --local-only --config fly.beeline-server.toml \
      --dockerfile apps/server/Dockerfile --app beeline-server \
      --build-arg "BEELINE_RELEASE_VERSION=$version" --build-arg "BEELINE_RELEASE_SHA=$sha" \
      --image-label "$label" --build-only --push --yes
  fi
  # Fly's builder can use a separate Docker daemon; pull before migrations.
  docker pull "$release_image"
else
  echo "unknown server image mode: $mode" >&2
  exit 1
fi
