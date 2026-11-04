# Private background clock ownership

This composition is unselected. `apps/server/src/tray-clock-work.ts` attaches to
existing leader hooks, source journal and recovery notifications. It introduces
no connection, lease renewal, recurring scan or retry timer. Installation and
readiness, the remaining private jobs, and rollout proofs are still required.

`background_leader_owners.lock_backend_pid` and `lock_backend_start` bind the
single current owner row to the exact existing PostgreSQL lock backend. They
are retained only with that row and replaced on the next claim; they are not
an event history, client inventory or observed client state. Both are necessary:
PID alone can be reused. The current database namespace, exact advisory key,
exclusive granted mode and backend start must match. Old rows without these
fields confer no permission. `beeline_background_backend_holds` clears cached
activity evidence before checking. The deferred Tray COMMIT guard rechecks this
physical ownership together with the generation, nonce and existing lease.

A backend lost after the final application SELECT cannot commit display expiry
or choice terminal changes. Real PostgreSQL tests cover that gap with a fresh
lease, another backend holding the same key, rollback of domain/card/source/
clock state, and one subsequent consumption by a fresh owner. Local tests use
an explicit test-only guard override; real PostgreSQL tests never install it.

An orderly local stop aborts active callbacks and drains transactions already
past their callback while retaining the actual lock. A JavaScript-only source
abort after the callback is not a database fact. This work does not claim a
post-callback logical-abort COMMIT guarantee. That boundary must be resolved
before selection if the final job policy requires it.

Central proofs: background leader10, ownership18 + PostgreSQL4, display clock10
+ PostgreSQL5, actual choice7 + PostgreSQL3, runner11. All passed with two or
fewer workers, serial suites, and the4096MiB Node heap cap. Only loopback throwaway
schemas were used. No production migration or lifecycle action was performed.


## Unselected readiness and coherent read basis

Readiness verifies the installed function bodies and PostgreSQL-parsed trigger
contract, then reconciles durable bounded phases before publishing a generation.
New empty Workspaces receive pending work; Room moves invalidate OLD and NEW
scope readiness with bounded foreground work. Every clock basis transition
advances its canonical Workspace cut, including expiry with no affected reader.

Central readiness14/source17/readiness PostgreSQL3/display PostgreSQL6,
display10/choice7/choice PostgreSQL3 and existing runner11 pass. Snapshot
composition adds committed-clock6/scalar-count9/projection17. The pure readiness
predicate rejects a naked ready bit and is shared by the actual basis and the
single-SELECT scalar badge. No read initializes or repairs readiness.

These are correctness proofs, not activation or performance acceptance. The
catalog fingerprint still deparses the bounded capture contract on reads; the
one-statement count does not establish cheap CPU. Readiness now walks bounded Workspace→Room→source keys, charging empty visits
and phase advances against the100-item budget. First and resumed pages use
single-key seeks: cold PostgreSQL otherwise chose a bitmap+sort for a100-row
page. Actual lifecycle SQL over4096 Rooms and33024 source rows passes cold
custom and generic EXPLAIN/BUFFERS bounds without ANALYZE or forced plans.
Readiness19/source17/traversal PostgreSQL1/actual runner7/owner PostgreSQL3/
committed reader6 pass (53). Single-key seeks add round trips; aggregate
source/WAL/CPU costs, old stored-deadline cohorts and migration/cohort floors
remain open. Production does not install or select these schemas.


The readiness lifecycle now runs as explicit `tray.readiness` work under that
same aggregate epoch and deferred COMMIT fence. One runner/subscription owns two
bounded journal positions; only actual durable pending work yields immediate
continuation. Opening source hints survive acquisition. Ownership19, existing
runner11, actual-schema readiness runner7 and real PostgreSQL readiness-owner3
pass. Backend loss between the final SELECT and COMMIT rolls back audit/source/
publication changes. No additional listener, leader lease or retry timer exists.

Reader health now has one current aggregate-owner initial-drain receipt, bound
to instance/generation/nonce and exact PostgreSQL backend identity. The existing
runner publishes it only after readiness and both deadline domains finish their
initial work, under the existing actual-COMMIT fence. `live` alone is still not
health. Pure reads require this receipt, current lease/backend, matching source
epochs with nonregressing heads, and no overdue pending deadline in the requested
Workspace. Future/unrelated source changes do not invalidate that Workspace.
Time only refuses admission; it never classifies cells.

The partial Workspace/due/id index is included in the readiness audit floor.
Real PostgreSQL health/ownership11 covers both pools, takeover, lease/backend
loss, stream resets and rollback, all five overdue kinds, unrelated Workspaces,
and physical access across33024 deadlines. Cold and generic plans use the
index with <=16 probe buffers and no whole-cohort sort/scan. Runner7/existing11,
source17+PostgreSQL3 and readiness19+PostgreSQL3/traversal1 pass. The root staged
scalar reader proof6 still uses one SELECT; its full Tray integration is not yet
in this published slice.

Production retirement wiring, active remote-cache loss propagation, final enqueue
checks, complete catalog/
source CPU/WAL/wire costs and cohort rollout remain OPEN. No production schema
is installed or selected by these private proofs.

## Durable retirement of the private runner

Parking now calls the existing aggregate owner's release once: local authority
ends synchronously, and its exact generation/nonce receives durable released_at
evidence. Run completion and close drain the retirement. Acquisition waits for
it before creating a new epoch. Routine journal hints and server lease renewal
never retry retirement or recover the runner. Real PostgreSQL12 includes the
actual runner and two application pools observing loss and real resync recovery;
actual-schema runner9 and existing leader11 cover stop/rollback and no retries.

A failed durable write is explicitly exposed as retirementFailed. The private
runner can ask the existing aggregate leader to park its exact backend after
active work drains. This grants no replacement attempt, rejects a stale backend
identity and discards earlier queued wakes. Leader11 proves zero timers/retries
through an idle day. PostgreSQL13 includes an actual failed release write and a
waiting advisory-lock acquisition proving physical ownership ended; the other
pool refuses the old receipt while released_at remains unconfirmed. Production
composition must supply this private callback; it remains unselected. Active
remote-cache notifications remain an activation gate. No new timer, lease,
listener or general retry policy was added.

## Shared committed availability control

`jobs:tray-clock-health` captures exact aggregate-owner and health-receipt
changes in their transaction. No-op updates and rolled-back changes emit nothing.
The capture floor audits both triggers; reference triggers for the two control
tables use an explicitly qualified `pg_temp` schema clone, so the audit does not
block remote health reads or drop a live control table.

`TrayClockAvailability` is one consumer per application server. It installs its
existing-Live listeners before baseline, coalesces hints, drains at most1024
closed control causes, preserves loss even when a later healthy generation is
already committed, and parks on unknown/gapped history. Only real feed recovery
opens a new baseline. A throwing socket listener cannot prevent later consumers
from receiving loss; failed delivery or an owner callback exception parks the
shared consumer until real recovery. It owns no timer, socket, client inventory
or data snapshot.
The actual two-pool PostgreSQL notification proof parks two simulated consumers
with four shared control statements, independent of consumer count. Availability9,
PostgreSQL14 and the source/readiness/traversal proofs pass.

Root's staged integration emits one `control:tray-clock` frame per socket and
parks only local Tray state. The modern Tray cohort requires the installed
shared consumer, and a parked consumer refuses snapshot admission before a read.
Projection24 and mobile-owner28 pass, including a late opening reply that cannot
restore parked data and an unaffected visible Room list. The phone/socket slice
is now in the combined PR and the aggregate owner bundle passes the hard budget
set by instruction034. Full production composition, workload/cohort proof and
the removal sweep remain open. No additional whole finding is closed.

Acquisition loss is also fenced after the claim returns: listener or exact-owner
loss during the claim await retires the returned generation durably, even when
it was never installed as the runner epoch. Retirement retains the captured
backend identity and drains outstanding releases. Both race regressions failed
with `released_at` still null before the fix; runner13 and real PostgreSQL14
pass after it. No source hint retries the retirement or reopens the runner.


## Production leader selection

The production entry point now selects `background-leader.ts`; the former
`background.ts` polling leader is removed. PostgreSQL holds the same advisory
lock across old/new server overlap. An actual backend loss admits one
replacement, and a brief open does not replenish it: the initial business cycle
must complete while that connection remains current. A distinct database
recovery can also reopen admission. Duplicate error/end events are one loss.

The Tray ownership, schema/readiness and shared availability composition remain
unselected. Existing job schedules still return their own deadlines; this
change removes leader probes, not their remaining recurring work. The actual
pool checkout beneath leadership must also make one attempt; the caller owns
recovery. Leadership, shutdown, expiry and real PostgreSQL overlap proofs
cover this boundary. Full F16/F17/F18 closure remains open.
