#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' 'Beeline monolith migration is complete; relay restoration is retired. Recover with npx usebeeline update.' >&2
exit 2
