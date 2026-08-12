# Buzz navigation performance — API 36

Measured on 2026-08-11 with the existing `emulator-5554` serial emulator (API 36),
the public Buzz relay, one `PerfLatency` Room, one participant, and zero Agents.
The Metro bundle was warm for both transition passes. Timing probes wrapped each
screen effect from entry to the state update that removes its blocking loader;
relay query probes wrapped `queryEvents`. All probes were removed after capture.

| Transition                 |         Before | After primary paint |             Improvement |
| -------------------------- | -------------: | ------------------: | ----------------------: |
| Workspace home / Room list | 5,634–6,793 ms |              779 ms | 86% vs. repeat baseline |
| Open Room transcript       |       5,159 ms |            1,039 ms |                     80% |
| Open Agents                |       2,099 ms |            1,133 ms |                     46% |
| Room navigation dispatch   |         109 ms |               <1 ms |                    >99% |

Accuracy-sensitive secondary data now hydrates without blocking the primary
screen: the home Room summaries completed at 2,147 ms and the Room member/profile
projection completed at 2,662 ms. The Room header shows a member-loading placeholder
until that projection is complete, so the participant total never exposes an
unfiltered intermediate count.

## Measured hot spots

- Every screen awaited a 1.1–1.9 second WebSocket connection before making HTTP-only
  bootstrap reads. The WebSocket is now opened lazily by the live subscription.
- The home screen waited for every Room's Corners, latest message, and membership
  projection before first paint. One Room generated more than 20 projection reads,
  including repeated kind-9007 scans returning 216 relay events. Room discovery now
  reuses one create-event scan, excludes Corners before exact metadata reads, and
  hydrates summaries after the list appears.
- Room history was fetched only after metadata, Workspace Agents, Workspace members,
  person profiles, and local persistence completed. History now runs with core
  metadata; cosmetic roster/profile reads and local writes are secondary.
- The initial focus callback duplicated the home load, and Agents polled four
  projections every two seconds even when no pairing was active. Initial focus is
  skipped and Agent polling is gated on an active pairing.
- Concurrent identical relay reads are deduplicated. Immutable exact kind-9007
  create records are memoized, broad create scans get a 500 ms handoff cache, and
  mutable membership/role projections are never retained after completion.

No Room/Corner styling, daemon/work trigger, Agent authority, or merge-gate behavior
was changed.

## Verification

- API 36 on-device transitions were repeated on the same `emulator-5554` fixture.
- `npm test`: 10/10 root workspace tasks passed.
- `npx vitest run --maxWorkers=1` in `apps/mobile`: 110 files and 996 tests passed.
- `npm run typecheck`: all root workspaces plus the isolated mobile TypeScript check passed.
- `npm run build`: all seven build tasks passed.
