# Corner state reference

`apps/server/src/corner-lifecycle.ts` owns the state type, pure `transitionCorner`
and `advanceCorner` runtime. Close and confirmed merge execute command/workflow/hold cleanup in that same module.
Every corner command enters that runtime; the generic
queue retains membership, provenance, deduplication and turn authority.

The machine persists one state on `corner_facts.machine`:

- **Working:** an implementing command or receipt is active.
- **Review:** checks are underway (`checks`), or the configured reviewer owns the
  current head (`reviewer`). The corner override wins over the parent Room reviewer.
- **Waiting:** an explicit blocker, user action or question needs an answer. These
  waits remain visible during work and CI. A merge hold vetoes landing while work
  continues; it becomes Waiting when it is all that remains.
- **Idle:** no implementing, review or waiting work remains.
- **Archived:** terminal after authorized closure or a confirmed merge. A locked
  standing corner remains active after a merge.

Red checks wake the implementer with the recorded failing jobs. Green checks wake
only the independent configured reviewer, inside the corner. Completed findings
and reviews without a usable verdict return ownership to the implementer once,
scoped to the reviewed PR and head; they never automatically repeat that review.
Reports retain their current order-author return route.

Committed changes to commands, receipts, GitHub facts, waits and holds enter the
same runtime. Server startup and listener resync replay recorded facts without
reading GitHub or starting a timer. State and effect receipts commit with their
commands. Reads render the stored machine state. Existing hidden lifecycle cards
remain inert history during the expand release; no new cards are written.

Coverage: `corner-machine.test.ts`, `corner-state.test.ts`,
`corner-state.exhaustive.test.ts`, `corner-state-reference.test.ts`,
`corner-review-dispatch.test.ts` and `corner-attention.integration.test.ts`.
`node --test scripts/corner-machine-boundary.test.mjs` plants violations of the
state-write and wake boundary; TYPECHECK runs the same guard through architecture
checks. The boundary has one owner and no per-call exemption list.
