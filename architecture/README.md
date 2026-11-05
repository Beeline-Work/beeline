# Architecture invariants

`invariants.json` lists where each key module's sinks may live. A rule names a
pattern (a SQL write, a notify, a timer, a merge call), the files that own it,
and a `total`: how many sites outside those files exist today. `total` is a
one-way ratchet. `scripts/check-architecture.mjs` runs in the TYPECHECK job.

The check reads sink ownership. Rules with `ownerFunctions` inspect TypeScript
function scope inside owner files too; `ownerSites` fixes the number of owned
sinks, so another implementation inside an owner function also fails. `filePattern`
keeps the read/adapt-only MCP transport family inside the real server source tree;
its command/turn writes are forbidden, including terminal fallbacks. A failure
names the rule, every site and the way to comply. Command creation, claim/lease
assignment, legacy subscription reads and corner archival are strict, with zero
external allowance. Their owner boundaries cannot be relaxed through a candidate
rule edit. Owner paths and function names may follow a mechanical split only when
every owned sink statement and its aggregate count match the base; changed SQL,
arguments, duplicated sinks and empty new owners fail. Negative fixtures live in
`scripts/architecture-invariants.test.mjs`.

The command-creation, live-notify, membership-write and server-interval rules
have zero exceptions. Command creation lives in the `agent-command` modules declared by the rule, including
explicit connected-app commands minted and claimed in one transaction. All helper
and MCP acquisition uses `claimAgentCommand`; only its successful working-turn
write can claim input/resume work. Lease progress uses a generation-fenced owner
operation. `archiveCornerState` alone runs corner archival cleanup. Subscriptions
live in `agent_subscriptions`; legacy JSON may be read only by named upgrade
functions. `membership-join.ts` owns
membership SQL and its conflict policies; callers pass their current transaction
and retain access checks. The `postgres-live` modules own named notifiers and SQL
expressions for atomic CTE/trigger notifications. `background-work.ts` drives
instance-local jobs by their queue deadlines and owns cancellable timeout chains
for live connections. Their close handlers cancel the chain.

## Code file size

The `code.file-lines` rule in the same architecture check caps every tracked
`.ts`, `.tsx`, `.js` and `.mjs` file under `apps/`, `packages/`, `scripts/` and
`tools/` at 1,000 lines, including tests. Only the exact generated paths declared
in the rule are exempt. New files must meet the cap when staged.

There is no oversized-file allowlist. `--base` rejects relaxing the cap, its
scope or the generated-file exclusions. Split by existing domain boundaries while
preserving behavior; do not compress code to fit. The service domains live under
`apps/server/src/phone/` and `daemon/`; their service classes retain constructors
and delegation for existing callers. Room feature hooks and child views live
beside `_chat-surface.tsx`; the monolith HTTP integration tests share
`apps/server/src/test-fixtures/test-support-monolith.ts`. The existing eight
integration batches balance these domain files, separately from ordinary server
suites, so each selected integration file runs once.

The UI component guard permits an existing legacy control to move only when its
JSX, resolved styles and aggregate count match the trusted base. Its registry
entries follow the moved controls; a copy or changed control still fails.

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
| Raise a `total`, `bootstrapTotal` or `unusedTotal`, remove a live rule, change `pattern`/`flags`/`scope`/`owners`/`distinct` or the storage `scope`, or change the guard scripts | Candidate invariants must pass CI; owner reviews the diff weekly after merging. |

Non-strict invariant changes pass CI when the candidate satisfies its declared
rules. Strict capability boundaries reject changes to their matching scope,
owner functions, owned sink count or zero allowance. Verified moves of unchanged
sink statements may update owner paths and function names; they cannot use the
weekly warning path to introduce another sink. `--base` reports those changes for the weekly audit;
it adds no approval or merge gate. CI executes the candidate guard. The owner
reviews invariant and guard diffs weekly after merging.

System message wording is not a rule here: it lives in the catalog exported by
`packages/api-contract/src/system-message-catalog.ts` and never blocks a PR.

The [2026-11-02 harness/settings/path sweep](seam-sweep-b.md) records the
remaining exceptions and why their callers still need them.

## Weekly audit

A scheduled Beeline agent turn (a due-time wake, not a polling loop) reviews
the week's merged PRs. The prompt is [weekly-audit.md](weekly-audit.md). It
opens tightening PRs on its own and reports invariant, System catalog and corner reference changes to the owner weekly.

## Machine connection and helper timers

`scripts/machine-connection-boundaries.mjs` runs inside the architecture check.
The helper physical connection belongs to `apps/body/src/live-link.ts`; server
machine output and login/version changes belong to `machine-connection.ts`.
`machine-connection-sinks.json` pins owned sink counts and can only shrink.
The server shutdown owner may follow its exact module split only when its sink
call tokens and counts match the trusted base; changed calls and duplicates fail.
A helper cannot acquire another reconnect/close/send path. Helper timers have
zero inventory allowance, including generated child code and timer aliases.
The sole exception is one stay-warm countdown in `AgentProcesses.workChanged`
in `apps/body/src/agent-process.ts`. The mutation suite plants a second
reconnect and timer and requires both to fail; TYPECHECK runs that suite.
