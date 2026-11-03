# Group A integrated candidate proof report

The draft adds real PostgreSQL closure workloads for F02/F03/F04/F05/F06/F08/F09/F20/F24/F25. It does not activate the router or close a whole finding based on a supported subset. The integrator owns the live closure ledger.

The fixture applies the production schema migrations in a unique schema on loopback PostgreSQL, runs two independent database/listener contexts and actual Beeline HTTP/WebSocket servers, and uses the real phone dispatcher, builders, source triggers, authority fences, lane owner and batch assembler. Test authentication is synthetic. Only test fixtures negotiate the capability; no deployment setting changes.

Run each suite separately from the repository root, with a loopback PostgreSQL URL in `BEELINE_COMMAND_TEST_POSTGRES_URL`:

```sh
npm test -w @beeline/server -- src/router-phone-group-a.postgres.test.ts --maxWorkers=2 --minWorkers=1
npm test -w @beeline/server -- --config vitest.router-group-a.config.ts --maxWorkers=2 --minWorkers=1
```

The second command is an explicit closure gate, separate from regression discovery. It refuses a missing PostgreSQL URL, and its formerly red assertions now pass on the integrated candidate. It is not an xfail suite or an approval to skip the unmet work. Every scenario retains the existing 20-second deadline; a cold full migration has its own explicitly authorized 120-second setup deadline.

Initial measured run: PostgreSQL 16.15, integrator base `0a864c56f`, seven scoped regressions pass; five closure gates reproduce implementation gaps:

| Finding | Executable test prefix | Initial evidence |
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

## First implementation increment

The unchanged F03, F04 and F05 server closure assertions now pass after adding a bounded Workspace roster family, a bounded Room workflow family, precise workflow-card causes, and negotiated changed-Room Needs-you facts. The latter carry the complete server order/count and at most 30 changed cells; mechanical application refuses missing rows and preserves one atomic count/cell cut, including pending baseline races. Older protocol clients retain full replacements unless they explicitly select `needsYouRoomsV1`.

The legacy `liveNeedsYou` path now reads the existing aggregate order/count boundary and only the changed Room's cells in one read-only repeatable-read transaction. It preserves the old display cap and wire shape, including the existing explicit-seen behavior.

Validation at this increment: real PostgreSQL F03/F04/F05 gates pass; F08/F09 remain red at their original missing-fact assertions. Core lanes 34, group publication 11, admission 14, new Room-fold 9, workflow consumer 3 and legacy Needs-you 39 tests pass. Server, mobile and net typechecks pass. The workflow consumer selects one negotiated path and releases all 16 unmounted Room observers. The roster client is deliberately not advertised before its remaining consumers are migrated. Full finding/cohort closure remains work in progress.

## Owner and profile implementation increment

F08 now has separate `owner-workbench` and `owner-wallet` families on `owner:<principal>`, independent of Workspace membership. Workbench snapshots use committed owner data and a transactional summary cell; they never call provider status, warm discovery, queue vault work, or read the wallet balance projection. Display shaping is shared with the existing adapter and runs on the server for the negotiated family. Wallet snapshots return an actual persisted provider observation, its observation time, and separate signing metadata. Missing observations stay absent. The existing refresh gesture invokes the explicit `refreshWallet` operation; a snapshot never provisions or refreshes an account.

Committed owner changes advance independent permission domains. Current-authority fences retire older private facts before enqueue, including ownership changes on the other PostgreSQL pool. Unsupported clients do not receive new authority-domain controls. The server's deployment capability remains disabled.

The negotiated profile paints the parent detail directly, passes that same object to portrait controls, and detaches its old cached-detail observer and event reads. The server supplies removal permission and a voice-specific revision, so a portrait revision cannot trigger another voice-catalogue read. Private grant facts are fenced after owner transfer and Workspace revocation.

Measured validation before the final profile revision increment: `router-phone-group-a.postgres.test.ts` passes 10 real PostgreSQL scenarios, including the two new F08 owner/purity tests and the F09 delayed-private-grant test. `owner-resources.router.test.tsx` passes three mounted consumer scenarios (shared facts, 1,000 legacy changes, owner key across Workspaces, pending/blur, explicit provider work). The phone network-channel check retains all 72 existing entries, architecture retains its existing limits, and the owner bundle gate passes after moving the workflow display-result graph outside the admission/fold entry. No assertion, byte limit, scenario deadline, or architecture allowance was raised.

The F08 source gate now uses a supported Tailscale connector and asserts its complete canonical display cell. The original Google-calendar fixture is absent from the current connector catalog; treating its legacy wire row as a rendered catalog row was an incorrect fixture assumption. The integrator reran all five source gates and ten PostgreSQL scenarios on the composed source; they pass. Complete consumer/cohort acceptance remains open. These scoped results do not close the full native/browser/legacy matrix or the remaining Members/picker consumer obligations.

## Integrator follow-up

Follow-up `d4ceadbe4` is composed with combined `6bf820def`. All five strict
source gates pass, including the exact supported Tailscale Workbench cell and
shared portrait revision; all ten broader PostgreSQL scenarios pass. No gate,
scenario deadline or byte budget changed. Mounted owner3/workflow3, actual router
owner29, Members management82 and wallet15 cases pass; the owner capability
expectation now names the four added families while retaining the empty-family
assertion without durable authority storage.

The integration also declares the two new owner projection tables and exact
JSON keys in the existing storage registry. Full removal and installed-cohort
acceptance remain as listed in [readiness](rollout-readiness.md).

Final composed validation: 210 Vitest cases across 13 serial suites, all eight
workspace builds, full root typecheck, three bundle gates, codec generation,
phone/router scanners and dead-code checks pass. The migrated storage registry
also exposed older undeclared owner-end and failed-schedule columns; these now
have explicit ownership and durable-evidence reasons. The workflow schema test
uses a complete typed authoritative row and retains rejection checks. Exact
commands, counts, bundle bytes and limitations are in
[integration evidence](group-a-integration-validation.json). The main-relative
architecture guard retains only the three individually documented staged
relaxations; remote CI and full rollout acceptance are not claimed green.

The router boundary follow-up corrects three errors found in the initial scanner
log. Pure workflow display validation is exported through the guarded public
barrel, not a new private package entry. The existing scanner declares the
bounded display adapter and permits its hook only from workflow, Workbench, Wallet and
Members profile consumers; 28 scanner regressions include rejection of aliases,
forwarding, dynamic imports and direct consumer lane authority. The inventory
and CI gate are unchanged. Affected owner/workflow consumer tests were rerun.
