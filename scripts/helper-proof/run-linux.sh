#!/bin/bash
set -euo pipefail
proof_root=$(git rev-parse --show-toplevel)
proof_node=$(command -v node)
proof_node=$(readlink -f "$proof_node")
proof_name="beeline-helper-proof-$$-$(date +%s)"
docker build -t beeline-helper-proof:local "$proof_root/scripts/helper-proof"
docker run -d --rm --privileged --cgroupns=private --tmpfs /run --tmpfs /run/lock \
  -v "$proof_root:/workspace:ro" -v "$proof_node:/usr/local/bin/node:ro" \
  --name "$proof_name" beeline-helper-proof:local
trap 'docker stop --timeout 15 "$proof_name" >/dev/null' EXIT
docker exec "$proof_name" node --input-type=module -e '
import { watch, existsSync } from "node:fs";
await new Promise((done, reject) => {
  const watcher = watch("/run", { recursive: true }, ready);
  const deadline = setTimeout(() => { watcher.close(); reject(new Error("private systemd bus did not appear")); }, 15000);
  function ready() { if (existsSync("/run/systemd/private")) { clearTimeout(deadline); watcher.close(); done(); } }
  ready();
});'
docker exec "$proof_name" systemctl start user@1001.service
docker exec --user proof --workdir /workspace \
  -e HOME=/home/proof -e XDG_CONFIG_HOME=/home/proof/.config \
  -e XDG_STATE_HOME=/home/proof/.local/state -e XDG_RUNTIME_DIR=/run/user/1001 \
  -e DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1001/bus -e BEELINE_NATIVE_PROOF=1 \
  -e BEELINE_PROOF_PHASES="${BEELINE_PROOF_PHASES:-}" \
  "$proof_name" node --import tsx scripts/helper-proof/prove-linux.mjs
