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
