# Corner and PR lifecycle audit

Snapshot: **2026-10-13 04:04:24 UTC**, PostgreSQL `BEGIN READ ONLY`. Source revision: `1e39bf4fe` plus the fixes in this branch. No production write, real agent action, helper lifecycle action, or emulator was performed. Read-only GitHub REST observations followed the database snapshot. Private transcripts, names, credentials, and raw query logs are intentionally excluded from the committed report.

Delivery: the four fixes below are separate commits on the authorized `fm/beeline-audit-corner-lifecycle` branch, in one direct PR to `main`. The brief permits pushing only that branch, so independent findings are separated by commits rather than additional push branches. The delivery URL and CI result are recorded after PR creation.

## Ranked findings

### 1. P1 — an unmerged PR closure never reaches the corner state machine (fixed)

**Production evidence:** corner `9a995687-e22f-4d7c-827e-4f34bf59f0bf` remains `ask_human / changes_requested`, with passing checks and no approval, active command, or working turn. Its recorded head is still the head of [the closed, unmerged PR](https://github.com/Beeline-Work/beeline/pull/2006). GitHub's `updated_at` is 2026-10-02 21:19:32 UTC. The latest corner card is dated October 9, so database state clearly does not express the PR's current availability.

**Code evidence:** `github-operations.ts` previously ignored `pull_request.closed` unless merged; `closeCornerPullRequest` cleared `lifecycle.pr` without calling `advanceCorner`; `reconcileMergedCorners` skipped every unmerged PR. The three adapters disagreed about closure. A tool-closed corner remained in `review` with no PR, and an externally closed corner retained a PR it could never merge.

**Fix:** `apps/server/src/github-operations.ts:1055` centralizes the local recording of PR closure. The tool, verified webhook, and existing reconciliation pass all clear the matching PR/check summary/recovery/approval and report `pull-request-closed` under the corner lock. The contract's `pr_closed` edge returns `checks`, `review`, `implement`, and legacy `ask_human` to `implement`. The corner and branch survive; no extra wake, timer, merge gate, or polling loop is introduced. A stale close for a replaced PR number cannot remove its replacement. `apps/auth/src/github.ts:587` now preserves GitHub's explicit open/closed state for reconciliation.

**Proof:** regressions failed before the fix for tool closure, webhook closure from legacy `ask_human`, and missed-webhook reconciliation. Added coverage exercises every new declared edge, approval invalidation, duplicate delivery, and a replacement PR arriving during the remote close.

### 2. P1 — recovered reviewer dispatch bypasses fallback after failure (fixed)

**Evidence:** `ensureReviewDispatch` queues `corner_review_dispatch` from an ordinary GitHub system note, while `reassignFailedCornerReviewer` previously admitted only a source message of kind `check-passed`. Thus the initial review could fail over, but its recovered counterpart could not. There are **zero reviewer fallback lists among the 27 open production corners**, so this is a reproduced latent defect, not a claimed current incident.

**Fix:** `apps/server/src/corner-lifecycle.ts:1005` recognizes the failed command's lifecycle purpose, retaining compatibility with check-passed `subscribed_event` commands. It checks the source head when present and carries the dispatch purpose through successive fallback reviewers. The same ordered reviewer list, health rules, and commander report handle both dispatch paths.

**Proof:** a recovered primary review previously failed without waking its healthy fallback. The regression now exercises both fallback delivery and list exhaustion. Existing first-dispatch and no-single-reviewer-fallback behavior remains covered.

### 3. P1 — merge cleanup leaves saved workflows live inside an archived corner (fixed)

**Evidence:** `closeCornerState` calls `abandonCornerWorkflowRuns`, while the GitHub `mergeCorner` transaction only cancelled commands and turns. A saved workflow's start card and timers therefore survived a merge as live work in an archived Room. A local regression observed `live` after the merge instead of `abandoned`. Production has **zero workflow timer rows in archived corners** at the additional read-only cleanup snapshot; no current leak is claimed.

**Fix:** `apps/server/src/github-operations.ts:2263` calls the existing `abandonCornerWorkflowRuns` in the merge transaction. That shared operation saves the terminal status, closes run choices, cancels run wakes, and removes timers. A merged repository does not imply an unrelated unfinished saved workflow succeeded, so its run is abandoned while the corner lands.

**Proof:** local merge with a live timed workflow now ends the workflow and removes its timers; duplicate merge delivery stays terminal. Human closure still uses the same operation.

### 4. P2 — seven non-null projections disagree with authoritative lifecycle cards (fixed)

**Production evidence:** exactly **seven** newest cards are `implement / no_code`, while `corner_facts` projects `implement / NULL`. These are the retired no-code migration's outcome discrepancies; no state-name discrepancy was observed. The current badge does not distinguish these two outcomes, so this is consistency debt rather than seven additional user-visible dead ends.

**Code evidence:** `apps/server/src/database.ts:1846` rewrote the no-code card state but retained its outcome, then cleared the projected outcome. `backfillCornerLifecycleRuns` selected only NULL `workflow_state`, so these non-null discrepancies could never be repaired.

**Fix:** `apps/server/src/corner-lifecycle.ts:1357` also selects drifted projections at the existing boot migration. Under the existing lock it reloads the newest card and projects that card, preserving history. The card remains the authority; the indexed projection remains a performance optimization. No recurrent audit, repair loop, or new state store is added.

**Proof:** regression starts with a non-null, wrong projected state/outcome, restores both from the newest card without rewriting history, and proves the next reconciliation is a no-op.

## Present state machines and transitions

`CORNER_LIFECYCLE_CONTRACT` (`apps/server/src/corner-lifecycle.ts:75`) is the only current transition contract. `advanceCorner` serializes it with the run lock. The newest `corner-workflow-handoff` card, ordered by integer `seq`, records the run. `corner_facts.workflow_state/workflow_outcome` are its indexed projection.

| State | Outgoing outcome → state | Meaning |
| --- | --- | --- |
| `opened` | `opened → implement` | Transactional opening receipt; no separately waiting worker |
| `implement` | `pushed/rechecked → checks`; `rereview → review`; `pr_closed → implement` | Current implementer's work, including failure/refusal recovery |
| `checks` | `passing/no_reviewer → review`; `failing/pr_closed → implement` | Server reads checks; absent reviewer becomes an explicit review gap |
| `review` | `approved/merge_unconfirmed → review`; `pushed/rechecked → checks`; `merge_refused/pr_closed → implement` | Current-head yes and review recovery |
| `landed` | none | Terminal, done |
| `closed` | none | Terminal, abandoned |
| legacy `ask_human` | `pushed/rechecked → checks`; `revision_work/merge_refused/pr_closed → implement` | Compatibility only; new contracts do not enter it |

Every nonterminal state admits implicit `landed` and `closed`. Terminal runs reject subsequent transition events. A brief revision normally changes no state and wakes only the implementer. A reviewer PASS is retained if checks are still running; the later green verdict can skip review and wake the implementer to land. A same-head green replay normally dispatches no second review. Failed or missing review delivery returns work privately to the implementer and reports one step up. `merge_unconfirmed` keeps review and wakes the implementer; a subsequent authoritative GitHub read settles or clears the claim. No contract state requires human escalation merely because an agent failed repeatedly.

The retained `opened` receipt and `approved → review` receipt are transactional history, not separately scheduled phases. Removing them would reduce bookkeeping writes but would also remove useful provenance and require compatibility/receipt changes; they do not create a live waiting state. `land`, `investigate`, `no_code_work`, and `upgrade_to_code` occur in historical production cards but are not current states. The complete observed historical edge/count inventory is [production-transitions.txt](production-transitions.txt), including start/backfill cards with no `fromState`.

The server also derives one display vocabulary (`packages/api-contract/src/corner-state.ts`): `archived` for archived/terminal corners; `working` while a turn runs; `review` for checks/review and failing-check implementation; `waiting` for legacy human waits, failures, or human-owed work; otherwise `idle`. The phone renders that projection. It is a view of the run/turn/owed facts, not a second transition machine.

### End-to-end authority and cleanup

1. **Open:** Body's `open_corner` calls `createCorner` (`daemon-service.ts:7079`); the active command authorizes scope and brief. Idempotency is parent-row serialized. The private objective command goes only to the selected implementer, inherits the order chain, and the opener watches lifecycle events. `createHumanCorner` (`phone-service.ts:6309`) starts the same Room lifecycle; a human corner may deliberately have no agent assigned yet.
2. **Work:** membership/reach authorizes operations. The branch is the shared artifact, not a competing run-state store. `cornerImplementerSql` resolves the human-selected worker, falling back to opener/creator. Helpers sync before turns and preserve unpublished work on cleanup refusal. Repository-free corners use scratch and never create a PR.
3. **Checks/review:** GitHub webhooks cause live reads. Parent Room reviewer configuration is authority, and subscriptions/membership are repaired projections. Command purpose identifies dispatch, not transcript prose. Review failures/gaps use the existing private report chain.
4. **Land:** only `GitHubOperations.landCorner` (`github-operations.ts:913`) calls the merge path. Current brief must permit repository work, current-head live checks must be green, current-head yes must be valid, and no hold may stand. The head claim contains concurrency. A refused merge returns work to implement; confirmation/webhook archives and records landed. No new merge requirement is introduced.
5. **Close PR:** closure changes the PR association and resets work, preserving the Room/branch. Closure of a PR is distinct from archival of the corner.
6. **Archive:** `closeCornerState` (`corner-close.ts:66`) and GitHub merge both cancel active input/resume/restart commands and working turns, settle saved workflows/timers, and persist terminal facts in their transaction. Lifecycle watches route to the original ordering address; they do not redirect command authority to arbitrary parent agents.
7. **Local cleanup:** `apps/body/src/room-runtime.ts:1861` verifies archival/access and unpublished work before worktree removal. A closed corner with an unmerged PR preserves its remote branch. A merged/no-PR corner can remove it; exact local refs authorize deletion. Errors preserve work or use existing scoped retry behavior. Local cleanup refusal is not another server lifecycle phase.

## Production counts

| Lifecycle run state | Open | Archived | Total |
| --- | ---: | ---: | ---: |
| `opened` | 0 | 0 | 0 |
| `implement` | 24 | 0 | 24 |
| `checks` | 2 | 0 | 2 |
| `review` | 0 | 0 | 0 |
| legacy `ask_human` | 1 | 0 | 1 |
| `landed` | 0 | 741 | 741 |
| `closed` | 0 | 162 | 162 |
| **Total** | **27** | **903** | **930** |

Raw `lifecycle.lifecycle`: `done` 903; `working` 23; `in-review` 3; `unknown` 1. These are old GitHub/transport facts, not the current run-state vocabulary. Current projected outcome counts for open corners: NULL 20, `opened` 3, `pushed` 1, `code` 1, `upgraded` 1, `changes_requested` 1 (NULL includes one checks row).

All 27 open corners have **zero pending/claimed commands** and **zero working turns**. The additional read of `corner_owed` found unexpired rows in two implement corners; those rows explain human waiting, not runnable agent work. The one pending command in an archived corner is a **stop / corner_close**, not surviving input/resume/restart work; it is the teardown signal and should not be diagnosed as an active assignment leak.

### Every open corner, with the limit of what the data proves

IDs are navigation keys only. “Idle after completion” means the latest turn completed, no command is active, and no PR is recorded. It does **not** prove that the person intended closure or that all promised work was delivered. Automatically closing or reordering these corners would invent intent and violate the read-only scope.

| Corner id | State | Evidence and disposition |
| --- | --- | --- |
| `ad53a97e-fbb6-4377-8d6a-d4402b0774df` | implement | Last turn complete Sep 2; no recorded command/PR/brief; current implementer membership exists. Legacy idle work, no automatic next transition. |
| `330e8650-e9fc-487b-8b0c-7af00675fc5f` | implement | Last human-tag command/turn complete Sep 13; no PR/brief. Idle; another order or explicit close is needed if work remains. |
| `ffa9fe26-c852-4821-bfe9-853e8cb3bd2e` | checks | Recorded PR, unknown checks, no reviewer, no approval; latest turn complete Sep 17. GitHub returns 404 to the audit identity, so live PR state/access cannot be established. Do not guess green, closed, or merged. |
| `bee11e00-0000-4000-8000-000000000104` | implement | Repository-free, no agent implementer, commands, or turns. Unassigned human/scratch corner; no agent progression is owed. |
| `de0fa005-0275-43da-805c-fa5b1fbbb887` | implement | Last turn failed Sep 29 with an ACP internal error; no active command or PR/brief. Work stopped at the failed turn; further intent requires a new authorized order/retry, not a fabricated lifecycle wake. |
| `9a995687-e22f-4d7c-827e-4f34bf59f0bf` | ask_human | **Confirmed stuck PR association:** closed, unmerged PR remains recorded; no yes, active turn, or owed row. Finding 1 repairs the missing close transition on existing reconciliation after deployment. One schedule exists; latest scheduled turn completed Oct 12. |
| `f3e3035c-abc5-4fa3-ac0a-3f4e0b9119a5` | implement | Repository-free; last turn complete Sep 26; no owed row. Idle scratch work, not a checks/review dead end. |
| `1b790275-17a8-4710-b78a-6d0ee2d9d13e` | implement | Initial corner-objective command complete Sep 26; one brief, no PR. Work stopped after implementation turn, not at a merge gate. |
| `b3d21a65-a2e0-4a0b-853d-1bcd18165729` | implement | Repository-free, no implementer/commands/turns. Unassigned corner. |
| `216e5604-fdde-4356-a61a-7ea70f79f755` | implement | Last human-tag turn complete Sep 27; one brief, no PR. Idle implementation. |
| `3d63aa9c-1f10-4969-a5d9-799839067afb` | implement | Last human-tag turn complete Oct 8; no PR/brief; one schedule. Idle between authorized turns. |
| `b94ff6ab-11ce-49cc-9a6f-5c196fcc079f` | implement | Repository parent but no implementer/commands/turns/brief. Unassigned human corner; no agent may infer a repository brief. |
| `845f05b2-30b5-44d9-84a2-eb56b526a46c` | implement | Repository-free; last turn complete Oct 6; no owed row. Idle scratch work. |
| `7d58d3e3-ba91-4b30-84bc-7fa44c0b769f` | checks | Recorded [open, unmerged PR](https://github.com/Beeline-Work/beeline-experiments/pull/3), same live head; stored checks pending since Oct 9; GitHub has no check runs and no commit statuses. No reviewer/approval. Latest subscribed-event turn completed Oct 13. The no-reviewer zero-check path intentionally does not synthesize completion; see deferred finding below. |
| `4b3f42c4-99f1-42b8-b974-52b9e28ef324` | implement | Repository-free; last turn complete Oct 5; no owed row. Idle scratch work. |
| `a914716f-cd6c-4663-b42a-6e1044dc2bb9` | implement | Latest watched-corner turn complete Oct 13; one schedule, one brief, four unexpired owed rows. Human waiting is supported; card/projection outcome drift is finding 4. |
| `5d03340b-f6f5-4673-a96f-35433ecdd092` | implement | Repository-free; last turn complete Oct 2; no owed row. Idle, plus finding 4 outcome drift. |
| `dcc3805a-7e17-4922-9a07-95c65c31166c` | implement | Repository-free, no implementer/commands/turns. Unassigned, plus finding 4 outcome drift. |
| `92b9c0a9-68fa-490d-83d4-e0a70e9f09ef` | implement | Last human-tag turn complete Oct 3; one brief, no PR; historic `code` outcome. Idle implementation. |
| `34fd63bc-cb93-4096-b787-4e3182ec233e` | implement | Latest scheduled turn complete Oct 13; five schedules, three brief revisions, no PR. Idle between schedules, plus finding 4 outcome drift. |
| `9e519c86-637d-427e-99f8-3882d53603f8` | implement | Last human-tag turn complete Oct 9; three briefs, no PR; finding 4 outcome drift. Idle implementation. |
| `dcc45c93-e7f2-4a62-890e-6e1adf39255c` | implement | Repository-free, no implementer/commands/turns. Unassigned, plus finding 4 outcome drift. |
| `00407964-1439-42cb-ab69-7e026a485d92` | implement | Last relay-steer turn complete Oct 9; seven briefs, no PR; historic `upgraded` outcome. Idle implementation. |
| `497a4fd0-2b85-42cd-b5f1-52ba07ce30a8` | implement | Last human-tag turn complete Oct 9; one schedule/brief, no PR; finding 4 outcome drift. Idle implementation. |
| `2d9975ab-c8a3-489d-b796-6165f842ea56` | implement | Last turn complete Oct 12; seven briefs, no PR; one unexpired owed row. Human waiting, no active agent command. |
| `9a4269ff-021c-43f0-b98a-fda30b3caee6` | implement | Last turn complete Oct 11; three briefs, no PR, no owed row. Idle implementation. |
| `cb44b101-38f9-4d80-b7c2-833c74b3c61a` | implement | Last turn complete Oct 11; one brief, no PR, no owed row. Idle implementation. |

## Deliberately left for review

- **Zero-check PR without a reviewer:** `daemon-service.ts:1846` requires a distinct configured reviewer before the worker-completion path can establish a zero-check head as passing. `corner-review-dispatch.test.ts:127` explicitly preserves the no-reviewer path. This accounts for the experiments PR's persistent pending state despite no check runs/statuses. Generalizing that path would change an expressly tested policy for distinguishing “no checks” from “checks not registered yet”; it is not a mechanical consistency repair. A decision can extend the existing completion mechanism without adding polling or a new gate. No production reviewer or real agent was changed.
- **Inaccessible legacy PR:** a 404 is not proof of deletion; resolving that repository requires an authorized account with access. There is no defensible data mutation from this audit identity.
- **Idle old work:** 24 implementation corners include five with no agent implementer, one latest failed turn, and two with current owed rows. Age and a completed turn alone cannot authorize closure or another agent order. The report supplies their evidence instead of silently changing customer work.
- **Account erasure:** `phone-service.ts:7941` has an explicit privacy-erasure archive path outside ordinary `closeCornerState`. It cancels commands, but performs direct archival/lifecycle writes while reattributing/deleting identities. Consolidating its workflow/history behavior needs account-erasure tests and a decision about retained personal provenance; substituting ordinary close side effects is not obviously safe. The current snapshot has no archived workflow timers requiring repair.
- **Old state strings and extra receipts:** historic no-code/land/investigate cards are immutable provenance except for existing migrations. The current contract has already removed the separately scheduled `land`, no-code upgrade, and automatic escalation phases. This change does not resurrect them or rewrite old history to conceal migration versions.
- **Duplicate read models:** PR/check facts, the run projection, and display badges have different roles. The run projection now reconciles from one source; live GitHub remains the merge authority. `close_requested` is a helper teardown transport fact, not another workflow. Removing these columns/read projections would broaden protocol and cache migration scope without fixing another observed dead end.

## Validation and delivery

Regression reproductions: closure 3 failures, recovered fallback 1 failure, non-null projection 1 failure, merge workflow cleanup 1 failure before their respective fixes. All proofs use PGlite/mock GitHub or an ephemeral localhost server and temporary checkout; no real helper manager is used.

Final local results: **283 tests passed** across `corner-lifecycle.test.ts`, `corner-reviewer-list.test.ts`, `corner-review-dispatch.test.ts`, and `github-operations.test.ts`; **30 GitHub client tests passed**; root `npm run typecheck` passed on the synchronized tree, including workspace, mobile, and script checks. Exact-head GitHub CI is recorded with delivery. `npm run prove:command-grammar` already passed: built MCP `open_corner`, private order/report routing and live socket delivery, lifecycle watch provenance, and no private coordination in transcripts/PostgreSQL notification payloads.
