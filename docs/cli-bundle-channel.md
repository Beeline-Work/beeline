# Beeline helper update channel

> **Current topology (2026-09-09):** the cutover below is complete.
> `usebeeline.app` is backed by GitHub Pages and `server.usebeeline.app` is the
> Fly monolith. The unified release has no legacy host mirror. The runbook is
> retained only as cutover history; do not execute its mirror-enable steps.

Helpers select the newest release at startup, on a pushed release notice, and once after socket registration from `https://usebeeline.app/dl/manifest.json`. That URL and
its relative platform archive and `.sha256` paths remain unchanged.
The recovery bootstrap migrates old installations forward to one native supervised helper.
Cloudflare remains the public TLS endpoint; GitHub Pages becomes the origin
for the entire website, including `/dl` and `.well-known`.

## Release authority and durable storage

When helper code or a shared helper contract is selected,
`.github/actions/daemon-leg/action.yml` combines install-verified native
`linux-x64`, `darwin-arm64`, and `darwin-x64` bundles under the release's exact
version and source SHA. The macOS builds run natively: Apple silicon on GitHub's
hosted macOS runner and Intel on the repository's self-hosted macOS runner. They
run only while this release identity still owes merged bytes; a retry that
already has that merged artifact promotes those exact bytes instead of
rebuilding them (see [the release pipeline](./release-pipeline.md)).
Other selective releases carry the last successful helper version, SHA, and
artifact reference.
Its promote phase passes `daemon-artifact-<version>-<sha>` to
`.github/actions/pages-leg/action.yml`. The Pages leg:

1. Verifies the artifact identity, every archive's digest and size, and sidecars.
2. Assembles the static website with those exact bytes, ignoring checkout `dl/`.
3. Saves the same files as GitHub Release assets on `helper-update-channel`.
4. Deploys the complete Pages artifact, including hidden association files.
5. Runs `scripts/verify-pages-update.mjs` against the deployed host.

The rolling `helper-update-channel` release is a prerelease, excluded from
GitHub's latest stable release selection. It supplies durable inputs for
website-only deployments after Actions artifacts expire. It is not the URL
helpers read on startup and release/reconnect events. `scripts/pages-channel.mjs` owns its upload/download contract.
Every caller holds the same `usebeeline-pages` concurrency group through
publication and deployment. An interrupted backup upload fails validation;
the next release retry replaces and repairs it. The previous Pages deployment
continues serving until a complete replacement is deployed.

Website changes are selected and deployed only by `unified-release.yml`; a
merge to main does not deploy Pages. Website-only releases reuse the durable
helper channel and never build or assign a second helper version. A missing or
corrupt channel fails closed, preserving the existing Pages site; it never
falls back to checkout helper bytes or the dev machine.

No new binaries are committed to Git (#647). The served Pages site and Release
assets are independent of the dev machine and Actions artifact retention.
Build runners still run the existing release jobs; moving those runners is a
separate task from retiring the dev relay services.

## Consumer and verification contract

The manifest uses schemaVersion 1, with `sourceCommit`, `version`, and
`bundles["linux-x64"]`, `bundles["darwin-arm64"]`, and
`bundles["darwin-x64"]` entries containing `file`, `sha256`, `bytes`, `node`,
`commit`, `version`, and `verified: true`. Every bundle and the top-level identity
must match the unified release identity. Source commit is the helper's primary
comparison; the unified release's `vX.Y.Z` is the version fallback.

The verifier requires the exact expected manifest, checks every SHA sidecar,
and executes the production `SelfUpdateManager` in a disposable prefix seeded
with an older identity. It fetches and hashes the actual tarball, extracts it,
smoke-tests the CLI, activates the stable anchor, checks the installed identity,
and runs the installed `beeline --version`. Release bundle verification does not
pair, start a production daemon, or touch an existing helper. The older identity
is a fixture that forces a same-release redeploy through the real updater path,
not a claim of fleet restart. Release-time smoke proves the published package
and manifest. Fleet uptake is asynchronous post-release observability and never
blocks delivery.

The PR gate `MAC HELPER ACCEPTANCE` runs on the repository's self-hosted Intel
Mac. Its filter is the macOS-specific sources alone — never the run-everything
fallback — so an ordinary `apps/body`, shared-package, or unmapped-path change
never queues behind that one machine. It performs a fresh installer run,
exercises launchd crash restart and a bootout/bootstrap cycle
(the closest non-destructive CI equivalent to a logout/login), verifies the
restart-after-any-exit and explicit native-stop contract, pairs against the in-process monolith, observes a
Room answer, and exercises `open_corner` with the deterministic ACP fixture. The
native Apple-silicon bundle is proven only by the release's own `helper_macos`
leg - or, on a retry reusing a merged artifact, by the attempt that built those
exact bytes - which runs the same installer/ACP/CodeGraph bundle proof on
GitHub's hosted arm64 Mac runner; no pull-request gate rebuilds it.

macOS has no bubblewrap namespaces. The helper therefore uses the existing
`bwrap`-unavailable fallback: it logs `harness OS sandbox UNAVAILABLE`, runs ACP
children without an OS-level filesystem sandbox, and relies on the permission
handler for the Room read-only rule. This is the same behavior as a Linux host
without a working `bwrap`; this release adds no substitute sandbox.

Having no bubblewrap also makes one product behavior reachable on macOS that a
Linux host with a working `bwrap` never sees: a granted command run in a
TOP-LEVEL Room is refused with `ROOM_SANDBOX_UNAVAILABLE`, because a Room run
is sandboxed or nothing (C94 fail-closed). Corner grants are unaffected — they
run on the host by design — so `run_granted_command` works in corners and
refuses in Rooms on every Mac.

Linux uses `Type=notify` and `WatchdogSec=180s`. macOS has no `sd_notify`
protocol; the helper uses the same local work-loop barrier with a bounded
three-minute watchdog that exits the process when progress stops. `KeepAlive`
restarts it. Native readiness and individual agent readiness remain separate.
The macOS helper log is `~/Library/Logs/Beeline/helper.log`; launchd does not
provide Linux's bounded journal rotation.

And the helper is supervised in the per-GUI-session domain, `gui/<uid>`, not a
system domain: the LaunchAgent loads when that user LOGS IN, not at boot, and
`launchctl enable|bootstrap gui/<uid>/…` fails outright when no Aqua session
exists. So a Mac needs a real logged-in session — autologin on a headless Mac
mini, or a human at the keyboard — for `beeline connect`/`beeline start` to
install the job at all, and for the helper to come back after a reboot; over
SSH with nobody logged in, pairing reports `its daemon did not start` and there
is no non-launchd fallback. The `gui/` domain is deliberate, not incidental:
Trusty Squire drives a real Chrome in that session, and Linux's
`systemctl --user` carries the analogous `loginctl enable-linger` requirement.

Redirects are refused in the hosting proof: a github.io redirect back to the
old dev origin must not count as a successful Pages verification. Use the
direct github.io URL before custom-domain setup and the public Cloudflare URL
after cutover. Pages propagation is retried for up to 20 attempts, 15 seconds
apart; stale manifests and checksum mismatches never count as success.

## Recovery and the first update from an old release

`npx usebeeline@latest update` runs a small recovery entry independent of the
installed body. It downloads, verifies checksum, Node requirements and imports,
then installs the stable launcher. It normalizes flat installs, real anchor
directories, old symlinks, broken forwarders and recorded Node paths. It disables
and stops legacy per-agent units before enabling the sole native helper. The
new unit has no exit-79 exception; an empty helper stays alive. Any exit restarts
unless the operator explicitly stops the native service.

The CLI that is already executing on an old machine still has its old behavior.
Use the new npm recovery entry for a dead or broken old install. After the first
forward migration, both installed `beeline update`/`beeline start` and npx select
the current release, ensure the native helper is running, and wait for a live
process-generation acknowledgment that every enabled agent is serving. A failed
agent is named with its reason. `update` preserves stopped agents; `start --all`
or `start --agent <key>` explicitly re-enables them. `update --status` is a local,
read-only observation; `--check` checks only the published artifact.

Legacy relay records sign the one-time authenticated
`/v1/auth/daemon/migrate-legacy` server route with their existing identity. The
server requires current owner and Workspace membership, and denies revoked or expired daemon credentials and repeat completed migrations. The exchange preserves agent identity,
policy, homes and sessions. Revoked or unrecognized identities show `needs
reconnect`; other agents continue serving.

One release transaction prepares in a private worker while intake stays open.
It hands over at a quiet gap or after at most five minutes. Before interruption
it flushes each active command's journal; the successor reclaims that command
without spending retries. Newer releases supersede prepared work without
renewing the drain deadline. Forced server minimums use the same transaction
with immediate interruption and a minimum-version check.

A stable `<prefix>/lib/beeline-bootstrap.mjs` and recorded Node path select the
body before importing it. `<prefix>/lib/beeline` remains an atomically renamed
symlink into immutable `beeline-releases/<id>`. Startup serves the last verified
release if publication is unavailable, with freshness explicitly unconfirmed;
it never disables the native restart owner. There is no rollback coordinator
or detached production fallback. `BEELINE_UPDATE_DISABLE=1` disables automatic
freshness checks, and is visible in local status; explicit updates still work.

The manifest's `recovery` entry pins the small bootstrap's file, checksum and
size. Bundle merging, Pages assembly and the durable helper channel preserve
and validate those exact bytes alongside the platform archives.

## Isolated acceptance

Never run lifecycle tests against a live user's install or native helper. Body
tests set private HOME/config/state paths and an unreachable user bus.
`lifecycle-test-guard.ts` refuses real paths, symlink aliases, and an unmocked
manager outside the disposable native-proof container. Native Linux proof lives
in `scripts/helper-proof/`: build the real bundle and npm tarball first, then
run `bash scripts/helper-proof/run-linux.sh`. It uses its own PID namespace,
PID 1, user manager, local HTTP/WebSocket server and deterministic ACP harness.
The container is removed at completion. See the acceptance evidence in
[helper simplification](./helper-simplification.md).

## Daemon update invariants

Paths and commands below are relative to the repository root. Read these invariants before editing this area; named code and tests hold implementation detail.

### Daemon self-update and CLI bundle

- **`<prefix>/lib/beeline` is the active bundle anchor**, a symlink into `lib/beeline-releases/<id>` swung by rename(2) (`self-update.ts`). `BEELINE_UPDATE_DISABLE=1` opts out of automatic updates. Never suggest `npx beeline` (an unrelated package); recovery is `npx usebeeline update`.
- **Update restarts are silent.** `runMachineHelper` closes the machine link before agent teardown with `HELPER_UPDATE_CLOSE_CODE`/`HELPER_UPDATE_CLOSE_REASON`; `DaemonAgentSession` releases presence without an offline notice only for that signal. Unexpected loss still notices the owner (`machine-offline.test.ts`, `daemon-live.test.ts`, `machine-helper.test.ts`). Release delivery pushes helpers only (`release-notify.ts`).
- **Routine updates wait at most five minutes for a quiet gap.** `ReleaseNotifier` (`apps/server/src/release-notify.ts`) pushes published helper releases; `MachineLink` (`apps/body/src/machine-link.ts`) reconciles the manifest once after the first registration on each socket, with no periodic update check. `ReleaseTransaction` (`managed-update.ts`) and `quiesceHostedAgents` (`machine-helper.ts`) keep intake open until idle or the deadline, then hand over; the successor activates the selected release. Deadline interruptions use `force-update-journal.ts`; the successor replays `update-interrupted` receipts and reclaims the same commands without spending retries. `machine-helper.test.ts` proves push, reconnect, and both handoffs over isolated HTTP/WebSocket. Installation is checksum verification plus atomic activation; no post-install probe or rollback. Server minimums (426 / `force-update`) interrupt immediately (`managed-update.ts`).
- `.github/actions/daemon-leg/` builds linux-x64 and darwin bundles; `launchd.ts` supervises macOS (no bwrap). `https://usebeeline.app/dl/manifest.json` stays pinned; runbook `docs/cli-bundle-channel.md`.
