# Self-hosted Checks rollout

This migration remains a draft until runner registration, capacity measurement,
and Mac artifact proofs pass. It reverses PR #1766's hosted-runner routing while
retaining its eight integration shards and current test assertions. The required
SERVER INTEGRATION verdict runs on `beeline-prod-host`; the shards and other
Linux PR Checks use `beeline-ci`. Required job names stay unchanged.

## Foreground Linux pool

Install and register eight separate GitHub Actions runner distributions as user
`lunchbox`, under `/home/lunchbox/beeline-ci/01` through `08`. Register each
with a unique name (`beeline-ci-01` through `08`), repository
`Beeline-Work/beeline`, label `beeline-ci`, and the default `_work` directory.
The registration route needs repository Administration write permission. Keep
registration secrets out of the repository, terminal transcript, and chat.

After registration, keep this checkout available for the hooks and run:

```sh
node scripts/start-ci-runners.mjs /home/lunchbox/beeline-ci 8
```

The supervisor runs in the foreground. It validates all eight executables before
starting, refuses a second supervisor, and stops the pool if a listener exits.
SIGINT/SIGTERM stop the child process groups; after ten seconds remaining
listeners are killed. A machine crash can leave `.pool-running`; verify no
listeners remain before removing that directory and restarting.

Each instance has its own HOME, XDG directories, temporary directory and
workspace. Before and after each job, hooks remove its workspace, job home and
temporary files. Shared action/tool caches stay in `_work`. Hooks reject
workspaces outside the instance or behind symlinks. These hooks do not remove
Docker containers or isolate the host network. Fixed ports, database names and
Docker resources still need auditing and live collision proof before promotion.

The user systemd bus is unavailable in the agent execution environment. This
foreground fallback applies no cgroup resource caps. Measure pool memory, host
load and agent availability during three concurrent PR runs; do not infer host
capacity from the fixture test. Check the execution context's memory limit before
starting the real pool: this agent session has a 31.41 GiB limit.

The fixture test starts eight listeners through the real supervisor, invokes
both real cleanup hooks, checks separate homes and verifies leftover workspace
state is removed. It also checks duplicate-start and unsafe-cleanup refusal:

```sh
node --test scripts/start-ci-runners.test.mjs
```

## Mac routing and remaining proof

Desktop macOS now selects `[self-hosted, macOS, X64, ios-builder]`. Its existing
Rust targets build both Apple architectures as `universal-apple-darwin`; an
additional `lipo -verify_arch x86_64 arm64` step checks the application executable.
The iOS build/upload job already selects that runner label and is unchanged.
Runner identity, online status, signing and the dry-run iOS proof remain pending.

The Intel helper leg uses `ios-builder`. Per the commander decision, the arm64
helper leg stays on its existing GitHub-hosted `macos-15` Apple-silicon runner
until a suitable self-hosted arm64 runner is registered. Its native architecture
assertion and verified-bundle requirement remain unchanged; no cross bundles
are introduced. The Korean MacBook Pro's architecture remains to be confirmed.

Desktop Linux/Windows and Prompt cases remain on their current runners pending
timing evidence. No release is dispatched by this rollout.

## Reproduction 2026-10-20

Baseline from the approved brief: PR #2665 Checks run 39478557035 took 44 minutes;
the longest queue wait was 19.6 minutes. Live after measurements are outstanding.
Record wall time, longest queue wait and longest job for at least three concurrent
PRs, and peak host memory/load with no agent going offline. The eight-listener
fixture proves launcher behavior only; it does not prove the under-15-minute goal.
