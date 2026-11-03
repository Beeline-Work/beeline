# Group A proof work in progress

The draft adds real PostgreSQL closure workloads for F02/F03/F04/F05/F06/F08/F09/F20/F24/F25. It does not activate the router or close a whole finding based on a supported subset. The integrator owns the live closure ledger.

The fixture applies the production schema migrations in a unique schema on loopback PostgreSQL, runs two independent database/listener contexts and actual Beeline HTTP/WebSocket servers, and uses the real phone dispatcher, builders, source triggers, authority fences, lane owner and batch assembler. Test authentication is synthetic. Only test fixtures negotiate the capability; no deployment setting changes.

Run each suite separately from the repository root, with a loopback PostgreSQL URL in `BEELINE_COMMAND_TEST_POSTGRES_URL`:

```sh
npm test -w @beeline/server -- src/router-phone-group-a.postgres.test.ts --maxWorkers=2 --minWorkers=1
npm test -w @beeline/server -- --config vitest.router-group-a.config.ts --maxWorkers=2 --minWorkers=1
```

The second command is an explicit closure gate, separate from regression discovery. It refuses a missing PostgreSQL URL, and its open assertions remain red. It is not an xfail suite or an approval to skip the unmet work. Every scenario retains the existing 20-second deadline; a cold full migration has its own explicitly authorized 120-second setup deadline.

Initial measured run: PostgreSQL 16.15, integrator base `0a864c56f`, seven scoped regressions pass; five closure gates reproduce implementation gaps:

| Finding | Executable test prefix | Current evidence |
| --- | --- | --- |
| F02 | `F02: one affected list update` | Both real servers deliver the same current list once; client reads and unrelated count projection queries remain zero. Complete consumer/cohort proof remains required. |
| F03 | `F03: 1,000 transient frames` | Transient frames cause no read; the committed membership supplies zero roster DTOs, expected one. |
| F04 | `F04 purity/seen`; `F04: one changed Room` | Pure snapshots, same-cut count/cells and exact replayed seen IDs pass. A changed Room rereads one unaffected Room's cell, expected zero. |
| F05 | `F05 schedule slice`; `F05: a committed saved-workflow start` | Sixteen released schedule lanes perform zero reads on changes and return with at most one read/key. The real saved-workflow start supplies zero workflow-list facts, expected one. |
| F06 | `F06: ten Workspace badges` | Every badge stays at or below 1 KiB; one changed Workspace emits one badge, with other-Workspace/full-Tray reads zero. Complete consumer/cohort proof remains required. |
| F08 | `F08: connector commit` | The committed connector change supplies zero Workbench cells, expected one; client performs no covering read. |
| F09 | `F09: a committed portrait revision` | Two consumers share one baseline read. The portrait commit produces `[0,0]` consumer updates, expected `[1,1]`, with no event read. |
| F20 | `F20: two machines publish` | Concurrent publishers write the shared account revision once; both phones receive one small cell per agent, preserve distinct context, and perform zero profile/Workbench reads. Complete consumer/cohort proof remains required. |
| F24 | `F24: send/reaction/delete/decision` | Same-principal cross-server replay preserves one effect for each operation, the other reader updates without a read, and legacy hints remain. Complete consumer/cohort proof remains required. |
| F25 | `F25: the closed picker` | Closed picker reads zero; concurrent opens use one real snapshot; a stale held roster cannot authorize a membership write after revocation. Complete consumer/cohort proof remains required. |

The picker proof uses the real picker admission predicate and shared surface registry, rather than mounting the entire chat screen. Native/browser/platform and complete legacy/new-consumer matrices are additional obligations. No CPU/WAL/native paint or whole-router non-regression result is claimed here.
