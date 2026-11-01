#!/usr/bin/env bash
# Reuse the self-hosted runner's Rust; never run a fresh rustup installer.
set -euo pipefail

if rustc --version && cargo --version; then
  exit 0
fi

cargo_bin="${CARGO_HOME:-$HOME/.cargo}/bin"
export PATH="$cargo_bin:$PATH"
if rustc --version && cargo --version; then
  if [[ -n "${GITHUB_PATH:-}" ]]; then
    echo "$cargo_bin" >> "$GITHUB_PATH"
  fi
  exit 0
fi

if ! command -v rustup >/dev/null; then
  echo 'Helper build requires working rustc and cargo, or an installed rustup to provision stable.' >&2
  exit 1
fi

rustup toolchain install stable --profile minimal
export RUSTUP_TOOLCHAIN=stable
rustc --version
cargo --version
if [[ -n "${GITHUB_PATH:-}" ]]; then
  echo "$cargo_bin" >> "$GITHUB_PATH"
fi
if [[ -n "${GITHUB_ENV:-}" ]]; then
  echo 'RUSTUP_TOOLCHAIN=stable' >> "$GITHUB_ENV"
fi
