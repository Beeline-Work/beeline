# Architecture invariants

`invariants.json` lists where each key module's sinks may live. A rule names a
pattern (a SQL write, a notify, a timer, a merge call), the files that own it,
and a `total`: how many sites outside those files exist today. `total` is a
one-way ratchet. `scripts/check-architecture.mjs` runs in the TYPECHECK job.

The check reads behaviour boundaries, never bytes: editing an owner file,
renaming a function, or moving an existing site to another file passes. A
failure names the rule, every site, and the one way to comply.

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
| Lower a `total`, add a rule, reword `invariant`/`fix`/`module`, register storage or mark it for deletion, lower `bootstrapTotal`/`unusedTotal` | None. Merge it. |
| Remove a rule whose pattern matches nothing any more | None. |
| Raise a `total`, `bootstrapTotal` or `unusedTotal`, remove a live rule, change `pattern`/`flags`/`scope`/`owners`/`distinct` or the storage `scope`, or change the guard scripts | Check stays red; owner merges by hand. |

A relaxing PR always fails the architecture check. It stays red, so no
auto-merge path can merge it. The repository owner (`lunchboxfortwo`) merges
it by hand with an admin override when desired. GitHub review approval does
not make the check pass.

CI runs the base commit's copy of the guard, so a PR cannot weaken the check
that judges it.

System message wording is not a rule here: it lives in one catalog file and
never blocks a PR.

The [2026-11-02 harness/settings/path sweep](seam-sweep-b.md) records the
remaining exceptions and why their callers still need them.

## Weekly audit

A scheduled Beeline agent turn (a due-time wake, not a polling loop) reviews
the week's merged PRs. The prompt is [weekly-audit.md](weekly-audit.md). It
opens tightening PRs on its own and reaches the owner only to relax a rule.
