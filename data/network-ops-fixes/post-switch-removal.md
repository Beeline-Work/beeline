# Post-switch removal build (not deployable while capability is off)

This branch is separate from the capability-off integration branch. It removes
phone fallback implementations only after the expansion/switch sequence and
supported-client floor have been proved. Do not deploy it before that sequence.
An incapable connection parks the affected surfaces; it cannot use an old reader.
Native runtime 40 remains a supported native runtime with compatible JavaScript;
this change does not establish its end-to-end compatibility proof.

## Actual deletions

- Room lists have one canonical router lane. The old list scheduler, individual
  Room watches, local message reducers, cached list restore and post-write list
  refresh are deleted. Sidebar, settings and deck observe committed DTOs.
- List corner marks and dropdowns render those DTOs directly. They no longer
  depend on a secondary corner store seeded by the deleted reader.
- Badges observe the count-only lane. Their old full-Tray reader is deleted.
- Agent usage observes its own router cell; embedded detail usage is no fallback.
- File metadata, link and playback authorization use router commands. The old
  HTTP metadata/link/play alternatives and legacy cache mode are deleted. The
  authenticated immutable byte request remains the documented HTTP exception.

The scanner declarations shrink only for the two deleted artifact HTTP sites.
No allowlist entry, scanner pattern, scope or budget was widened. Parallel path
limits are server 18, helper 29, phone 19, equal to main. The permitted notifier
owner exception and temporary unified server environment switch remain distinct
architecture findings. An equal name-pattern count is not an empty boundary sweep.

## Regression migration

The retired list-store and SurfaceRegistry integration tests asserted the removed
scheduler, reducer and secondary cache behavior. Their replacements in
`chat-list-store.test.ts` and `router-owner.test.ts` exercise the actual router:
mount alone cannot read; navigation admits one shared read; hidden/revealed
observers and old receipt callbacks cannot mint passes; committed facts replace
canonical state without another request; incapable connections and prior-identity
responses cannot restore private state. Existing Room head/replay tests retain
responsibility for transcript storage, rather than a Room-list delta consumer.

UI suites feed complete server DTOs at a canonical-lane test boundary, preserving
navigation, settings, corner and gesture assertions. They do not emulate the old
watch/reducer or claim transport admission proof. Count hook tests verify no full
Tray read or subscription; the real owner suite proves count admission and replay.

Instruction 046 preserves the deleted-Workspace cache-then-server sequence. Its
UI case holds the Workspace reply, observes exactly one canonical list snapshot
from the cached Workspace selection, then releases the empty Workspace reply and
asserts that rows disappear with no further list reads. The fixture supplies an
authorized canonical DTO; it is not a raw disk restore. Spec §5 (line 175) still
requires private cached content after interruption/cold restore to stay hidden
until an authorized snapshot or content-free certificate proves current access.
The real owner tests, not this UI fixture, cover that authority boundary.

## Remaining removal gates

This is a partial removal build. Full Tray legacy machinery, Workspace readers,
generic phone/daemon contracts and other migration inventory entries remain.
The unified switch is intentionally still present until the validated switch;
there is no deployed ledger-aware floor yet. The required final boundary inventory
must still become empty, with every supported operation routed through its one
owner and supported native/cohort proofs. No additional audit finding is closed
by these source deletions alone. The integration closure ledger remains the source
of truth.

## Local validation

All Vitest suites run individually with `--maxWorkers=2 --minWorkers=1` and
`NODE_OPTIONS=--max-old-space-size=4096`.

| Proof | Passing cases |
| --- | ---: |
| Actual list store / actual router owner | 5 / 30 |
| Remaining notification filter identity / corner dropdowns | 1 / 5 |
| Conversation row / desktop corner display | 11 / 1 |
| Sidebar / Workspace settings / deck including instruction 046 sequence | 43 / 35 / 37 |
| Tray and count hook | 14 |
| Media connection / byte owner / artifact links / usage cell | 16 / 7 / 11 / 10 |
| Phone shadow, trusted owner and helper bundle budgets | 3 |

All eight workspace builds pass with serial Turbo execution. The two documented
T7 proof CLI entrypoints are registered with Knip, making their imported adapters
reachable without an export exemption or baseline increase. The unused draft-frame
helper left by the removed list reader is deleted.

Mobile typecheck, UI policy, both existing network scanners and the dead-code
baseline (5 existing findings, zero introduced) pass. Architecture passes all20
rules against the stacked combined base. The architecture guard
against `origin/main` still fails on the retained `live.notify` owner and temporary
server environment count 60→61; there is no parallel-path count mismatch. These
are reported failures, not waived checks or a claim that CI is green.
