#!/usr/bin/env bash
set -euo pipefail

# Copy every platform and preserve the upstream manifest bytes, so a GHCR
# digest in a Dockerfile identifies precisely the same image as Docker Hub.
sudo apt-get update -qq
sudo apt-get install -y -qq skopeo

mirror() {
  local source=$1 destination=$2 digest=$3
  skopeo copy --all --preserve-digests \
    "docker://docker.io/$source@$digest" \
    "docker://ghcr.io/beeline-work/$destination"
  local mirrored_digest
  mirrored_digest="sha256:$(skopeo inspect --raw "docker://ghcr.io/beeline-work/$destination" | sha256sum | cut -d' ' -f1)"
  test "$mirrored_digest" = "$digest" || {
    echo "Mirror digest differs: $destination is $mirrored_digest, expected $digest" >&2
    return 1
  }
  echo "Mirrored $source@$digest to ghcr.io/beeline-work/$destination"
}

mirror library/node ci-node:22-bookworm-slim \
  sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392
mirror rhysd/actionlint ci-actionlint:1.7.7 \
  sha256:887a259a5a534f3c4f36cb02dca341673c6089431057242cdc931e9f133147e9
