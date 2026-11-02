# Architecture invariants

`invariants.json` lists where each key module's sinks may live. A rule names a
pattern (a SQL write, a notify, a timer, a merge call), the files that own it,
and a `total`: how many sites outside those files exist today. `total` is a
one-way ratchet. `scripts/check-architecture.mjs` runs in the TYPECHECK job.

The check reads behaviour boundaries, never bytes: editing an owner file,
renaming a function, or moving an existing site to another file passes. A
failure names the rule, every site, and the one way to comply.

## Changing a rule

| Change | Review |
| --- | --- |
| Lower a `total`, add a rule, reword `invariant`/`fix`/`module` | None. Merge it. |
| Remove a rule whose pattern matches nothing any more | None. |
| Raise a `total`, remove a live rule, change `pattern`/`flags`/`scope`/`owners`, or change the guard scripts | The owner's yes on the exact PR head. |

A relaxing PR fails the check until Beeline holds that yes. The owner answers
in a normal Beeline Room message, replying to an ask that names the PR and its
head commit. The agent that message commands calls `approve_architecture_relax`
with the PR number and head. CI reads the record from
`GET /v1/public/architecture-approvals` and the job is re-run. A new commit
needs a new yes.

CI runs the base commit's copy of the guard, so a PR cannot weaken the check
that judges it.

System message wording is not a rule here: it lives in one catalog file and
never blocks a PR.

## Weekly audit

A scheduled Beeline agent turn (a due-time wake, not a polling loop) reviews
the week's merged PRs. The prompt is [weekly-audit.md](weekly-audit.md). It
opens tightening PRs on its own and reaches the owner only to relax a rule.
