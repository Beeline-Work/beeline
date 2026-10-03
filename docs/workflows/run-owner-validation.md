# Workflow run owner validation

A person who opens a workflow sees its owner and run starters; an agent trying to start another agent’s workflow sees the owner and active run IDs.

## Reproduced

Reproduction OWNER-1: an owner agent saves and starts a workflow through the authenticated daemon API. A second Room agent, with its own claimed command and daemon token, starts the same workflow. Before this change both calls succeeded and returned different full run IDs. The original reproduction used the existing `scripts/prove-workflow-run.ts` server harness; the committed owner proof repeats that same path.

The regression proof was also copied to a detached checkout of base commit `0588cc8e` and run there. Its expected rejection assertion failed with the second agent’s start returning HTTP 200. On the changed branch it returns HTTP 403 naming Scanner, its owner identity, and the first run’s complete ID.

Reproduction OWNER-1, review finding R1: the extended `scripts/prove-workflow-owner.ts` starts a run in the parent Room, then calls `startWorkflow`, `loadWorkspaceSkill` and `listAgentSchedules` as a non-owner agent in a member corner. Against head `c1f5683b`, the start returned HTTP 403 with “Active run IDs: none”, and both reads returned empty active-run lists despite the live parent run. The two new ownership regressions also failed before the query fix.

The host’s `adb devices` listed an offline emulator. The server test runner and Chrome were reachable, and supplied the reproduction and UI verification.

## Demonstrated

Run from the repository root:

```sh
npm run prove:workflow-owner -- /tmp/workflow-owner-demonstrated.json
```

Reproduction OWNER-1 now passes. The proof starts an isolated HTTP server with two authenticated daemon identities and a human admin, saves and starts `daily`, and rejects the peer’s start with the owner and active run ID. It builds and opens the real workflow page in Chrome at 1280px and 390px. The page reads the live authenticated phone API, shows Owner / Scanner and the full run ID, and has no horizontal overflow. At phone width the human clicks Change owner, selects Peer, and the page reloads the server’s new owner. The existing run still identifies Scanner as its starter.

The browser harness supplies Expo navigation and native-device shims, using the existing web proof harness. The workflow components and ownership/transfer HTTP operations are real. It uses no production Workspace or live model-backed agent.

The extended proof now passes R1 through the same authenticated HTTP paths: the corner start error names Scanner and the full parent run ID, and the workflow read and corner schedule list expose that same ID. The active-run query resolves a corner to its parent Room and includes readable corners of that parent, retaining membership filtering and terminal-state exclusion. Regression tests exclude unreadable corners, unrelated Rooms and ended runs, and verify removed parent membership hides that parent's run. Chrome still verifies the actual workflow page at both widths and a human owner transfer. During R1 verification `adb devices` showed a connected emulator; the reported agent-tool path was exercised through the service and Chrome rather than the mobile device.

R1 validation: 90 tests pass across ownership, workflow runs, workflow run views, agent schedules and institutional skills. The initial combined run encountered imports missing while the dependency build was cleaning its output; after that build completed, all three affected suites passed on retry. All seven server/dependency builds and the script TypeScript check pass. The running-service and Chrome evidence was written to `/tmp/workflow-owner-r1-demonstrated.json`; CI and a fresh exact-head review remain pending.

## Coverage

- `workflow-ownership.test.ts`: owner default and revision preservation; owner/peer/admin starts; active-run visibility; handoff without ownership; schedules, execution as current owner, human attribution; Room and Workspace admin rights; creator-human transfer, agent/member refusal and audit; creator migration, latest-schedule fallback and no-owner state; definition catalog before any runs.
- `workflow.browser.test.ts`: owner avatar/name, authorized controls, no-owner assignment and empty runs, all three starter kinds, transfer request/reload, phone/desktop widths and catalog visibility.
- Existing workflow run, schedule, skill and browser regressions remain in the validation run. `agent-schedule-tools.test.ts` covers workflow target forwarding and owner/run-ID formatting.

## Validation limits

The full server suite passed 1,506 tests and the API contract suite passed 336 tests. After syncing current main, the affected server and browser suites and service/type builds are rerun before publication.

The broader helper and mobile suites were attempted. They are not fully green on this host. Unchanged-base runs reproduce helper fixtures refused by the corner’s branch push restriction, a helper-presence assertion, and the machine-ID fixture’s assumption that `/dev` is unwritable. The mobile base also reproduces the native fingerprint mismatch and three release-canary assertions that encounter the unavailable sanctioned emulator before their expected EAS paths. Long session temporary paths additionally caused Unix socket/browser failures; rerunning with `TMPDIR=/tmp` removed those failures. Required installed mobile notification patches were applied before the final mobile run.

These unrelated checks are reported as failing, not counted as passes; no release, fingerprint, emulator or host policy change is included in this workflow fix. CI and the configured reviewer’s exact-head verdict remain pending at publication.

## Verification after resolving merge conflicts

Merged main at `b93b99d3`, retaining both the workflow ownership imports and the new corner hold imports in the daemon and phone services. The affected server suites pass 165 tests, helper suites pass 56 tests, API contracts pass 336 tests, and workflow browser suites pass 9 tests. Server and dependency builds, mobile and script type checks, whitespace checks, and the dead-code gate pass (zero introduced findings).

Reproduction OWNER-1 still passes against the running isolated service and workflow page: the peer receives HTTP 403 naming Scanner and the complete active run ID. Chrome shows the owner at 1280px and 390px, and a human transfer to Peer updates the header while preserving Scanner as the existing run's starter. CI and fresh reviewer approval are pending for the updated head.
