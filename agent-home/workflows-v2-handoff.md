# Workflows v2 implementation handoff

Source: the current request in this corner (Workflows v2: static checker, workspace registry, and the code-corner port). This is an implementation plan, not a claim that code has changed.

## Delivery sequence

1. Extend the shared workflow definition and checker in `packages/api-contract/src/workflows.ts`. Use one checker entry point for `check_workflow`, `put_workflow`, publish validation, and start-time validation. Return `{ok, errors: [{rule, state, path, message}], bounds: {durationMs, agentTurns}, nonSuccessRoutes}`. Keep the definition version immutable after a run starts.
2. Add the workspace registry and discovery tools. Store built-ins from repository `workflows/<name>/WORKFLOW.json`, workspace publications as immutable versions, and Room drafts with Room scope. Resolve duplicate names in the stated priority order: built-in, workspace, Room draft. Show layer and version in both listing and reading so a shadowed draft remains inspectable by explicit layer.
3. Add approval and cost enforcement at the server transition that starts a run or publishes a definition. Persist the check result with the version. Make approval refer to the exact candidate version and check digest, then recheck that identity before publishing or starting. Record both approval and denial in the run or publication log.
4. Add `code-corner` as a built-in and run it in shadow. Replay real corner histories through current routing and workflow routing. Compare ordered wake targets and causes, including head changes during CI, failed checks, review findings, approval, holds, and merge denial. Keep existing corner routing authoritative until the parity criterion is met.
5. Add a reviewed script-step registry and input/output contracts. Ship desk workflows in the requested order.

## Checker details

- **Structural errors:** validate identifiers, start/end states, edges, timeout routes, loop caps, output contracts, declared success states, and script-step names before graph analysis. Each error has a stable rule code plus the state and JSON path. Invalid structures must not crash later passes.
- **Field flow:** for each state, compute fields definitely available on entry as the intersection of predecessor exit sets. An agent or script step adds only fields guaranteed by its output contract on every result path. Treat failure and timeout outputs separately. Resolve every `$.field` in guards and input maps against the entry set. Iterate to a fixed point across joins and capped loops.
- **Events:** validate wait events against the server's actual emitted-event registry, including Room event kinds; do not maintain an independent guessed list. Validate the event payload contract if a wait maps payload fields into later steps.
- **Guards:** enumerate finite values from the referenced output enum, plus success, failure and timeout variants where applicable. For each possible value, exactly one route must match. Report uncovered values and unreachable/overlapping routes at their guard paths. A free-form field needs an explicit default route or a finite declared domain.
- **Reachability and intent:** unfold capped loops into bounded visits, traverse each feasible result/guard/timeout branch, and report every terminal route outside `success`. Record a compact counterexample path with branch labels and loop counts, rather than printing a combinatorial number of equivalent paths. Reject when no feasible path reaches a declared success state. A non-success terminal may be an intended failure; report it without silently treating it as success.
- **Bounds:** calculate the longest feasible path to any terminal state. Sum per-step timeout and retry allowance; count each agent attempt as an agent turn. For parallel branches, duration is the maximum branch duration until the join and turns are the sum of branch turns. Multiply full body costs by nested loop caps, including retries inside loops. Include waits and human gates in duration only when they have finite timeouts. If any route lacks a finite bound, return a named bound error. Expose duration in an unambiguous unit and document whether the bound includes queue delay; an execution-time bound cannot promise wall-clock completion if agent scheduling has no deadline.
- **Skills and roles:** check step skill names against the workspace skill catalog during definition checking. At run start, resolve every role to an agent and check that agent's current skills cover every step the role can execute. A missing role or skill blocks start with a named error.

## Registry and gating details

- `list_workflows` returns name, purpose, trigger, layer, and version for each visible effective definition. `read_workflow` accepts explicit layer and version to inspect shadowed or historical definitions. Per-turn recall uses the same resolver and includes open run ID, current state, and next action; keep it short and scoped to the Room.
- Publication creates a new immutable workspace version after a passing check and a human choice-card approval. Never let a pending approval publish a later edit to the draft. Built-ins retain priority if a workspace workflow shares a name.
- Room draft runs need no approval only when duration is at most 30 minutes, agent turns at most 10, and no reachable step can merge, place an order, or write externally. Treat a bound or side-effect classification error as requiring correction before start. Published versions run without an extra workflow gate; existing domain gates still apply.
- Enforce per-run and per-workspace daily turn caps atomically when reserving the next agent turn. On exhaustion, transition to a failed terminal reason and log it. Define the workspace day boundary explicitly in configuration.
- Human jump, reassign, and kill commands require a person identity and log actor, prior state/assignment, new state/assignment, time, and reason. A jump must still pass the workflow's state validity and existing domain gates; otherwise it could bypass merge holds or order limits.

## Code-corner parity

The built-in controls implementer/reviewer wake routing and a capped review/fix cycle. Both turns finish through `complete_workflow_step`; reviewer output is either `approve_merge` or structured findings. CI wait watches the PR's *current* head SHA and restarts observation when the head changes. Merge asks the existing merge gate for checks, mergeAllowed, and human holds; the workflow never performs the merge.

For each replay, compare wake order, recipient, triggering event, and current PR head between legacy and shadow traces. At minimum include a replay with one failed CI, a subsequent fix, one `changes` review, a further fix, and an approval. Include hold and head-change replays before switch-over. Record every disagreement with both traces and the first divergent transition. Agree on a concrete number and selection of real corners before enabling the workflow as the live router.

## Acceptance test map

- AC-1: unknown field, unknown emitted event, missing enum route, overlapping or dead guard all produce stable rule/state/path errors.
- AC-2: nested loops, retries, parallel joins, timeout/failure routes produce finite worst-case duration and turns; a reachable non-success end appears with a counterexample path.
- AC-3: publish approval pins a draft version; a second Room lists/reads that version and sees it in ambient recall; an older run stays on its original version.
- AC-4: boundary cases at exactly 30 minutes and 10 turns run ungated; above either bound or with a reachable merge/order/external-write step waits for a choice card.
- AC-5: replayed failed-CI/changes/approval corner has identical ordered wake traces. A changed PR head cannot satisfy a wait with checks from the old head.
- AC-6: jump, reassign, and kill each persist actor and before/after state in the run log; invalid jump cannot bypass an existing gate.

## Decisions needed before coding

1. Define the exact workflow JSON schema and emitted-event catalog from the engine, rather than inventing names from this request.
2. Define whether the bound includes agent scheduling delay and the timeout of human approvals. A finite wall-clock bound requires finite deadlines for both.
3. Specify publication conflict behavior when a built-in has the same name, and how callers request a shadowed workspace or Room version.
4. Specify the workspace daily-cap timezone and the measured shadow-parity sample before live cutover.
