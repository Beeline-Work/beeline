# Architecture invariants

`invariants.json` lists where each key module's sinks may live. A rule names a
pattern (a SQL write, a notify, a timer, a merge call), the files that own it,
and a `total`: how many sites outside those files exist today. `total` is a
one-way ratchet. `scripts/check-architecture.mjs` runs in the TYPECHECK job.

The sink check confines matching syntax to declared owners. It does not prove
that an owner exposes only one capability. The phone-network and router-boundary
checks also inspect lifecycle capability exports and raw server socket access;
the connection rules have zero external allowance. Negative type assertions
prove phone handlers cannot close a connection through their client view. A
failure names the rule, every site, and the one way to comply.

The command-creation, live-notify, membership-write and server-interval rules
have zero exceptions. Command creation lives in `agent-command.ts`, including
explicit connected-app calls that start claimed. `membership-join.ts` owns
membership SQL and its conflict policies; callers pass their current transaction
and retain access checks. `postgres-live.ts` owns named notifiers and SQL
expressions for atomic CTE/trigger notifications. `background-work.ts` drives
instance-local jobs by their queue deadlines and owns cancellable timeout chains
for live connections. Their close handlers cancel the chain.

## Storage registry (bloat inside a module)

`storage` in `invariants.json` registers every table, column and jsonb key,
each with its owner module and a one-line reason it cannot be derived:

- `apps/server/src/storage-registry.test.ts` runs the real migrations and fails
  on any table or column that is not registered, or registered but gone.
- The guard fails on a jsonb key read in SQL (`col->>'key'`) that is not
  registered under `storage.jsonb.<col>`, and on a registered column with no
  writer or no reader in non-test code (`unusedTotal` ratchets today's 197).
- Today's storage carries the reason `existing before the registry; weekly
  audit reviews`, counted by `bootstrapTotal`; a new entry needs its own reason.

For a column scheduled for deletion, replace its reason string with an object:
`{ "reason": "The existing reason.", "drop": "release 1.2.3" }`. A table can
carry `drop` beside its existing `reason` and `columns`. Use a non-empty PR URL
or release note reference. These columns (or every column of a marked table)
do not count toward `unusedTotal`; lower that total if needed. The reason and
`bootstrapTotal` accounting still apply, and the entries must match the schema
until the migration drops them. Remove the entries when they are dropped.

Registering a new table, column or key is not gated. Fix a failure by
registering with a reason, or by deriving the value instead of storing it.

Rules `settings.*` (distinct environment variables: settings and feature
flags) and `paths.*` (declared legacy, fallback or compat variants) ratchet
each app so a module cannot grow a second path for the same job.

## Changing a rule

| Change | Review |
| --- | --- |
| Lower a `total`, add a rule, reword `invariant`/`fix`/`module`, register storage or mark it for deletion, lower `bootstrapTotal`/`unusedTotal` | Normal CI and merge authority. |
| Remove a rule whose pattern matches nothing any more | None. |
| Raise a `total`, `bootstrapTotal` or `unusedTotal`, remove a live rule, change `pattern`/`flags`/`distinct`, shrink `scope`, widen `owners`, or change the storage `scope` | Fails the trusted-base check, even when the candidate satisfies its own rules. |
| Narrow `owners`, add scan roots, or edit guard code | Normal CI and merge authority; guard source edits are reported separately and the candidate runner executes. |

`--base` rejects policy relaxations rather than issuing weekly-review warnings.
There is no override flag. CI executes the candidate guard, so this is a rule
comparison, not a claim that the guard can protect itself from arbitrary source
rewrites. Guard changes still receive ordinary code review.

The [connection-door audit](connection-door-audit.md) records the kept shutdown,
identity-boundary, helper-protocol and test-injection exceptions. The old `paths.*`
name counts also include unrelated display defaults, installed-data migrations
and generated vendor code; they are not evidence of a single capability owner.

System message wording is not a rule here: it lives in one catalog file and
never blocks a PR.

The [2026-11-02 harness/settings/path sweep](seam-sweep-b.md) records the
remaining exceptions and why their callers still need them.

## Weekly audit

A scheduled Beeline agent turn (a due-time wake, not a polling loop) reviews
the week's merged PRs. The prompt is [weekly-audit.md](weekly-audit.md). It
opens tightening PRs on its own and reports invariant, System catalog and corner reference changes to the owner weekly.
