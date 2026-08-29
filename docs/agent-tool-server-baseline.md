# Beeline agent-tool server Phase 1 baseline

Recorded 2026-08-28 from `fm/agent-tool-server-build` after merging current `origin/main`.

## BASELINE SCOREBOARD

`PASS (native)` means the actual ACP harness and its production mount route emitted a visible Beeline tool call. `PASS (shared)` means the harness-neutral Body authority/relay/landing path is pinned by the same integration test used by every harness after dispatch. The native workflow probe uses an isolated deterministic host binding; it does not post into an owner's Room.

| Scenario | Codex | Claude | Pi | Grok | Evidence |
| --- | --- | --- | --- | --- | --- |
| Tool mount + `read_mandate` | PASS (native) | PASS (native) | PASS (native) | NOT RUN | `probe:agent-tools <harness>`; Grok CLI was not attached to a usable TTY/session on this host (`os error 6`) |
| `open_corner` and simulated retry return one corner id | PASS (native) | PASS (native) | PASS (native) | NOT RUN | `probe:agent-tools <harness> --workflow`; each transcript contains two calls and the same corner id |
| Inline `deliver({name, content, audience})` carries content and returns hash/size | PASS (native) | PASS (native) | PASS (native) | NOT RUN | Native workflow transcript; `candidateBytes`/upload integration covers the shared capture boundary |
| `close_corner(..., land)` returns the approval-pending business result | PASS (native) | PASS (native) | PASS (native) | NOT RUN | Native workflow transcript returns the same structured `approval_pending` shape |
| Human approval lands the exact tip, confirms it, then archives | PASS (shared) | PASS (shared) | PASS (shared) | PASS (shared) | Body landing tests: clean merge-ready, approved local landing, moved-target realignment; the tool calls the existing pipeline |
| Signed agent mention dispatch, serialized writer lease, fuse at six | PASS (shared) | PASS (shared) | PASS (shared) | PASS (shared) | `agent-mention.test.ts` round-trip/tamper/fuse/lease cases |
| Broken identity/schema/inventory handshake fails closed | PASS (shared) | PASS (shared) | PASS (shared) | PASS (shared) | `agent-tool-host-broker.test.ts` plus startup inventory assertion |

The production relay/mobile approval-card tap was not repeated by this change in order to avoid posting into standing Rooms. The existing landing and signed-event integration suite is the proof at that boundary; a fresh production throwaway-Workspace run remains a release canary, not a claim made by this scoreboard.

## Native transcript summary

All three available harnesses produced the same ordered call sequence:

1. `read_mandate({})` → generation `1`.
2. `open_corner({objective: "add a haiku file"})` → a harness-specific corner id.
3. The identical `open_corner` retry → the same corner id.
4. `deliver({name: "index.html", content: "<!doctype html><title>Bee</title><p>Hello</p>", audience: "parent_room"})` → 45 bytes and SHA-256 `eeb7746400848c429800090be7abd83e3ed89b56cf19917934525026f3eb5296`.
5. `close_corner({corner_id, disposition: "land"})` → `approval_pending` with a canonical event/request id.

The visible native names were `mcp.beeline-agent-tools.*` (Codex), `mcp__beeline-agent-tools__*` (Claude), and `beeline-agent-tools_*` (Pi). Pi ran through the generated extension and release-pinned adapter; no runtime install occurred.

## Validation

- Phase-1 contract/kernel/broker/mount/mention suites: 44 passing.
- Focused Body mount/Squire authority cases: 3 passing.
- Focused landing/capture/dedup cases: 6 passing.
- Root typecheck, including mobile: passing.
- Full `apps/body/src/body.test.ts` comparison: branch `312 passed / 13 failed / 3 skipped`; clean `origin/main` `312 passed / 13 failed / 3 skipped`. The failures are identical baseline cases.

