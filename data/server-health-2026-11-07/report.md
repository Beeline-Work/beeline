# Server health evidence, 7 November 2026

Status: **factory hypothesis rejected for lack of demonstrated savings; semantic census unfinished**.
This is an evidence checkpoint, not completion of brief criterion 2.
No server behavior, authorization, transaction setup, or regression test changed.

## Service boundary comparison

Measured from the repository's squash-merge commits, comparing each commit to its
first parent. An edit means a contiguous `git diff --unified=0` hunk, including
imports, documentation and tests. It does not mean one semantic requirement.
The per-file hunk ledger is in `cochange-counts.json`.

| PR | Merge commit | Files | Edits | Added/deleted lines | Server files/edits |
| --- | --- | ---: | ---: | ---: | ---: |
| 3991 | f82f7635f5fa7c5d07dc2d61ca07e6abf26e4b0a | 204 | 956 | 4872/4407 | 185/911 |
| 4037 | 8a264fe5d51e04136080b5511bb0ae12dc6ff741 | 3 | 10 | 38/39 | 3/10 |
| 4062 | 09738b4fbdd25a02421dea58671f6903e921155c | 43 | 128 | 371/264 | 24/87 |

Counterfactual design: one typed factory receives existing service dependencies
and installs transaction-local database, command, buffered live hub, embedding
and post-commit queue. It replaces positional dependency construction, including
the unused provider slots. It does not absorb operation arguments, authorization,
SQL ownership, projection behavior or schema migrations. Expanding it to own those
would change the hypothesis and erase the safety boundaries being assessed.

| PR | Same-change counterfactual file/edit estimate | Reason |
| --- | --- | --- |
| 3991 | 204/956 | Native SQL, row ownership, unique indexes, migration version, fixtures and error telemetry still change. `daemon/execute.ts` removes an advisory query and an authorization argument. `phone/command-context.ts` changes stop authorization. Neither is dependency forwarding. `database.ts` and `database-migrate.ts` retain different runtime and migration ownership. |
| 4037 | 3/10 | The receipt query and return projection still change in `phone/mention-notices.ts`; callers still pass the routing flag and remove the separate read in `phone/messages.ts`; the facade still drops the removed helper/import. A scope factory does not combine the query or remove the public helper. |
| 4062 | 43/128 | Report recipient selection, hash inputs and commander return rules still change. The daemon facade and dispatcher remove the operation-specific `to` argument; it is not a service dependency. Tests, schema shape, prompts and MCP tools still need the same edits. |

These are **static counterfactual estimates**, not measurements from an implemented
alternative. The observed positional construction in `daemon/execute.ts` forwards
existing dependencies, but none of these three diffs changes that construction.
Demonstrated savings: **zero of three**, below the required two. Do not ship the
factory on this evidence. This rejects this proposal for these samples; it does
not establish that no future dependency addition could benefit from a factory.

A replay against a real alternate implementation has not been performed. No
claim is made that the hunk estimates prove a lower bound for every conceivable
redesign. The generation/cancellation, Room access, commit-before-provider,
post-commit task and phone reply regressions remain untouched.

## Census scope and method

The earlier tuple supplies an aggregate of twenty candidates across three
boundary files, but no individual site ledger. The prior day's phone-operations
count uses a different file scope and cannot serve as a whole-server baseline.

The referenced census rubric lists value-specific branches, caller-specific
parameters, swallowed exceptions, retries/sleeps and disabled tests:
https://github.com/caldoai/skills/blob/main/skills/untangle-codebase/SKILL.md
Only that taxonomy informs this inventory; its broad refactor instructions are
outside this corner's scope.

`node data/server-health-2026-11-07/inventory.mjs` parses every tracked JS/TS file
under `apps/server`. Tests and fixtures contribute disabled/conditional-test
candidates only. It records every file, including files with zero matches, in
`candidate-summary.json`; every candidate has file, line, column, category,
disposition and source excerpt in `candidate-sites.csv`.

| Candidate category | Count |
| --- | ---: |
| Value-specific branches and switch arms | 3333 |
| Non-propagating exception-handler candidates | 373 |
| Explicit string-valued sets | 38 |
| Retry, sleep or scheduling calls | 23 |
| Disabled or conditional tests | 95 |
| SQL conditional policy markers | 1497 |
| Boolean parameter and legacy-slot candidates | 176 |
| Total candidates | 5535 |

The inventory covers 832 files at source commit
`00b345c83b2ad74cb0eacd496c02a3e2d66a4984`.
**5535 is a candidate count, not a completed semantic special-case score.**
Two unused `_legacyProviderSlot` parameters are explicitly avoidable compatibility
slots. They remain in place because this brief forbids an unmeasured refactor.
The other 5533 entries require semantic adjudication; do not describe them all as
required policies, avoidable exceptions, confirmed defects, or a clean bill of
health. Some are ordinary validation, deliberate scheduling or migration syntax.

Known limitations of the candidate generator:

- Literal comparisons and Set membership are broad candidate discovery, not a
  proof that a design failed to account for a requirement.
- Boolean parameters include ordinary options; non-boolean caller-specific
  parameters need manual discovery.
- A throw anywhere in a handler excludes that handler from non-propagating
  candidates, even when another path swallows. Rejected return values and
  indirect callbacks also need semantic review.
- SQL markers can occur in comments or schema strings and do not constitute a
  SQL parser. SQL expression branches outside these markers need review.
- Timer calls include required scheduling. Aliased timers, indirect retry
  helpers, dynamically disabled tests and commented-out tests need review.
- Line/column plus excerpt identifies candidates at this SHA; the inventory is
  not a cross-version stable identity scheme.

`semantic-markers.txt` records an additional textual search for compatibility,
fallback, workaround and legacy references. It is a discovery aid, not another
score or a complete semantic ledger.

## Remaining acceptance work

Criterion 1 has a conservative no-refactor verdict and a measured historical
baseline. The alternative's counts are estimates, explicitly not replay proof.
Criterion 2 remains unmet. Review the candidate ledger and uncovered constructs,
retain required policy/recovery/compatibility sites with per-site reasons, mark
avoidable exceptions with evidence, and record the resulting semantic total.
Reconcile the original twenty sites if their original ledger becomes available;
do not fabricate a one-to-one mapping from the aggregate.

## Validation

- Corner preparation passed.
- Candidate generation completed without parser diagnostics.
- CSV rows, summary totals, per-category totals and file manifests reconcile.
- A second generation is byte-identical at the same source SHA.
- Historical diff counters were recomputed independently from `git diff`.
- Server suites, built-app proof and disproof regressions were not run: this
  checkpoint changes only audit data and an offline source analyzer. No refactor
  is proposed, and no runtime behavior is claimed demonstrated.

This is not a defect report. No production reproduction is claimed.
