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

Reader health remains a separate activation gate: runner `live` only means its
epoch and source heads were acquired. Both application servers must verify
initial drain completion for the current owner epoch; an old persisted ready
bit or a local-only healthy flag cannot certify takeover completion.
