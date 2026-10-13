# Helper lifecycle and acceptance

One native user service owns one helper per machine. Its process states are
`starting`, `serving`, and `stopping`. Every exit returns through the native
manager unless the operator explicitly stops that service. Zero enabled agents
is a serving machine. Each enabled agent has its own retry loop and diagnostic;
ordinary failures retry indefinitely at capped backoff. An authority or
configuration refusal remains visible until a revision or explicit start.

The independent recovery entry selects verified code before importing the
body. Installed `beeline update`/`start`, `npx usebeeline@latest update`/`start`,
and the shell installer use the same preparation, installation lock and native
convergence. Completion requires a live generation and every enabled agent's
successful discovery and live registration. Local PID files and native READY
alone cannot satisfy that result. A refused agent makes the command fail with
its identity and reason while its siblings keep serving.

The release transaction keeps intake open during preparation and while waiting
for a quiet gap. Its drain allowance is five minutes, never renewed by a newer
target or failed handoff. Before interruption, active command journals are
flushed and atomically published. The successor reports them before opening
intake; server receipts reclaim the same commands without spending retry
budget. A server minimum uses this transaction with immediate interruption.
Checksum, import, engine and embedded identity checks precede activation.

## The first update on an old machine

The first new recovery invocation normalizes flat or real-directory installs
into immutable releases, repairs the stable anchor, forwarders and recorded
Node path, removes native exit suppression, and replaces old per-agent or pinned
helper jobs with the sole native helper. Retirement uses native process groups
and a common 90-second shutdown ceiling. A legacy per-agent entry queues its
own native successor before retiring its calling job. That first topology
replacement cannot rely on the old process's absent control protocol; subsequent
updates use the bounded quiet handoff.

The already-running CLI of an old release still contains its old behavior. A
dead or damaged old install should use `npx usebeeline@latest update`. After
migration the installed CLI itself is independent of a broken body. Existing
stopped markers survive update; `start --agent <key>` and `start --all` express
which agents to re-enable.

An old relay record proves possession of its existing identity to the server's
one-time migration route. Current owner and Workspace memberships authorize
the exchange; revoked, expired or unknown authority does not. Identity, home,
policy and work survive. Interrupted delivery can redeliver the same still
authorized credential, including after the exchange's initial delivery window,
without minting a second token or reviving a revoked one. No relay serving or
manual transport deletion is part of recovery. Deploy the server migration
seam before expecting old agents to serve; a temporarily unavailable seam
retries independently.

Publication failure preserves verified runnable code and the native restart
owner. Startup records freshness as unconfirmed. A mutating CLI still recovers
the installed service and reports that freshness failure; it never claims the
machine is current. Dependency convergence failures also remain visible.

## Recorded validation (2026-10-12)

The final isolated Linux run passed all 18 native phases on the built fixture
archive (SHA-256 `f8f0c13a1b3db53b76d3c2fcb1bf03ee63feabbff7af821b53381f8ee11da379`).
The fixture assigns synthetic release identities from `v0.2.0` through `v0.2.5`;
these are test artifacts, not a published release. The real five-minute drain
and forced minimum each produced one reply with zero additional retry attempts.

Root typecheck and workspace build passed. The final body suite passed 2,137
tests; the rebased server authority/database/live suites passed 96 tests;
shared packages passed 871 tests; publication and installer scripts passed 22.
Shellcheck passed and Knip introduced zero findings against the existing baseline.
Native launchd could not run on this Linux worker; its generator, bounded local
watchdog and migration fixtures were checked, and the opt-in unique-label test
remains available on macOS. No production rollout is asserted.

The follow-up control-socket proof ran on an isolated macOS 26.5.1 directory
with Node 20.19.6. The original 108-byte socket path reproduced `ENOENT` at
`chmod`; normal macOS temporary paths and a 332-byte Unicode state/operator
home then served through 66-byte machine, browser-share and Registry MCP sockets.
`local-socket.ts` derives short directories under literal `/var/tmp` from the UID
and socket-scope hash, checking owner, directory type and private permissions.
The state home, install path and macOS `TMPDIR` cannot lengthen those endpoints;
`/var/tmp` also remains visible to Linux Room clients with private `/tmp`.
`machine-control.test.ts` covers distinct installations, permissions, symlink
substitution and event-driven successor acknowledgment with long state paths.
`hosted-socket-path.test.ts` starts and exchanges messages with both hosted
servers from a long Unicode home, including agents with the same key prefix.
The required `MAC HELPER ACCEPTANCE` gate separately exercises a freshly built
native bundle, unique-label launchd restart/stop, pairing and actual Room replies.

## Reproducible acceptance matrix

`scripts/helper-proof/run-linux.sh` creates a disposable Docker PID namespace
with systemd as PID 1, a dedicated `proof` user, private user bus and isolated
install/config/state. Its fixture runs the real server routes, database,
HTTP/WebSocket transport and deterministic ACP harness. It exercises the real
published shell installer, installed CLI and packed npm recovery entry. It
never controls the host's user manager. The runner prints a JSON phase ledger
with elapsed times, release identity and HTTP operation counts and removes its
container afterward.

| Audit criterion                | Native fixture and supplementary regression coverage                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Current bundle, dead helper | Exit-79 suppressed unit recovered by real npx update; installed repeat converges without a new generation; installed update and both installed/npx start recover disabled and stopped services.                                                                                                                                                                                                                                         |
| 2. Old topology                | Real anchor directory, broken forwarding, pinned ExecStart, active old per-agent instances and the caller's own legacy handoff; flat/mixed layout, aliases and recorded Node covered by `self-update-layout.test.ts`; old launchd labels by `launchd.test.ts`.                                                                                                                                                 |
| 3. Legacy relay                | Signed migration with deliberately lost credential reply; preserved identity/home/policy; unknown identity and revoked sign-in fail by name while the sibling answers. HTTP authority/replay/removal tests: `legacy-daemon-migration.test.ts` in the server.                                                                                                                                                   |
| 4. Empty and explicit stop     | Both fixture agents stopped while the machine remains alive; update preserves stops; start restores them in the same generation. Empty machine, new pairing and start racing a draining stop: `machine-helper.test.ts`.                                                                                                                                                                                        |
| 5. Crash containment           | Native SIGKILL and watchdog recovery; revoked agent restored by its runtime revision without a machine restart. Three ordinary failures followed by success with a live sibling: `machine-helper.test.ts`; continued Room retries: `room-supervisor.test.ts`.                                                                                                                                                  |
| 6. Actual readiness            | Native replies plus live generation acknowledgment; malformed and unknown agents cannot pass convergence. Invalid acknowledgment rejection and stale/recycled PID behavior: machine control/status and runtime regression tests.                                                                                                                                                                               |
| 7. One transaction             | Real installer, manual CLI, pushed release and newer target during drain; same kernel owner for all preparation. Push/reconnect, concurrent notices, stage wake and lock-owner death: `machine-helper.test.ts`, `managed-update.test.ts`, `kernel-lock.test.ts`.                                                                                                                                               |
| 8. Bounded handoff             | Real five-minute busy drain with sibling work, newer target and durable journal; one replayed reply and zero additional `hiccup_attempts`. Quiet-gap handoff and failed-journal retry without a new allowance are also exercised.                                                                                                                                                                              |
| 9. Boundary faults             | Native killed download owner, shutdown and successor startup; lost migration exchange response; checksum/import/engine rejection; npx repairs an unimportable body. Private child SIGKILL immediately before/after credential and anchor rename, during verification and journal flush: `helper-boundary-fault.test.ts`. Real server minimum uses immediate preparation/handoff and replay without retry cost. |
| 10. No polling                 | Native idle operation counts remain constant; `no-polling.test.ts` advances four healthy idle hours with zero daemon reads and enforces the source contract. Kernel locks and readiness subscriptions wait on socket/file events. Every hosted core participates in the local watchdog barrier.                                                                                                                |
| 11. Platform and ceilings      | Real isolated Linux user-service crash, watchdog and explicit-stop behavior; common native shutdown ceiling is 90 seconds and body hard stop is 80 seconds. Generated launchd direct exec/KeepAlive and local watchdog are checked on Linux; unique-label native launchd acceptance runs only on macOS when enabled.                                                                                           |
| 12. Release and cleanup        | Actual Linux archive install/MCP/ACP/CodeGraph probe; npm entry and shell installer; bootstrap checksum/size preserved by bundle merge, Pages and channel tests. Deleted production detached fallback, exit mapping, distress authority, duplicate updater and public per-agent readiness export.                                                                                                              |

The native Linux proof and source regressions are complementary. Linux cannot
execute launchd, and these results do not claim acceptance on a real deployed
machine or a production rollout. The opt-in macOS test owns a unique label and
private HOME; it never bootouts `app.usebeeline.helper`.

Build the real archive with immutable native binaries for the requested
platform, then build and pack the small npm entry:

```sh
BEELINE_BUNDLE_VERSION=v0.2.0 \
BEELINE_BUNDLE_COMMIT=1111111111111111111111111111111111111111 \
BUZZ_AGENT_BIN=/absolute/path/to/buzz-agent \
BUZZ_DEV_MCP_BIN=/absolute/path/to/buzz-dev-mcp \
node scripts/build-beeline-bundle.mjs --platform linux-x64
node scripts/build-usebeeline-package.mjs
mkdir -p scripts/helper-proof/artifacts
npm pack --workspace usebeeline --pack-destination scripts/helper-proof/artifacts
bash scripts/helper-proof/run-linux.sh
```

Body test setup gives every worker a short private HOME/config/state and an
unreachable bus. `lifecycle-test-guard.ts` checks physical paths, including
symlink aliases, before any lifecycle or install mutation. Native calls in
ordinary tests require a mocked manager. The sole Linux native exception also
checks Docker, PID 1, the dedicated user, exact paths and private bus.
