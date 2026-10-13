#!/usr/bin/env bash
set -euo pipefail
installer_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
# The developer entry uses the same published recovery bootstrap as every install.
exec /bin/sh "$installer_root/relay-stack/web/install.sh" "$@"
