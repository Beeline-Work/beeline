# Beeline agent lifecycle audit

Base: `0c25de34924295cd220dfcbdb846fc83e8853fc4`. Worktree isolation verified with both physical path and git top-level. No production DB, real agents, helper unit, private runtime homes, or emulator were accessed. CodeGraph was not initialized and its MCP tools were unavailable; this audit used source reads. The project-memory convention helper reported no changes needed.

## Ranked findings

1. **Fixed: contradictory escalation and duplicate coordination rules.** `apps/body/src/prompt-assembly.ts:380` gives agents one private order/report grammar. Previously `core.authority` said to report “one step up, to the person who started the chain,” while `core.tagging` and `corner.steering` said to report to the commander. These can be different recipients in a nested order. `apps/server/src/commander.ts:151` routes to the author and return address of the incoming order, not directly to the original human. Removed that conflicting sentence, removed `corner.steering`, and trimmed the repeated Room/DM reporting instructions. A single core rule now explicitly says `report(text) one step up to your commander` and keeps private cross-Room orders, report statuses, human return addresses and exact handles. Four surface regressions enforce that ownership and turn-prefix delivery. No server state machine or new gate was added. Delivery PR: recorded below after creation.

2. **Retained history has no corner-archive expiry policy.** `apps/body/src/room-runtime.ts:538` expressly preserves `scratch/agent-home` and `scratch/agent-private`; `:1951` suspends the session but retains harness conversations/auth and removes only the corner marker. `corner-local-state.test.ts:12` asserts that history survives. Thus “close cleans up everything” is false by design: processes and work files go, durable harness state stays. Left for a retention-policy decision; deleting auth, conversations or private assets during an audit would violate the existing executable contract. No production footprint was measured, so there is no claim about current disk totals.

3. **Corner briefs are re-read and resent on every attempt, including warm turns.** `apps/body/src/monolith-corner-turn.ts:1703` checks revisions at assembly time; `prompt-assembly.ts:857` always renders the current brief, approval quote and delivered file manifest. Specs can be 16,000 characters (`packages/api-contract/src/daemon-operations.ts:1311`), so assignment text can dwarf the 38-token saving. Left intact: this is the authority for what may be built, and revision reads catch edits during slow context/file delivery. Hash-based omission needs evidence about harness compaction, retries and re-pins before it is safe. `PromptSectionBaseline` currently measures unchanged sections, without using that observation to suppress them.

4. **Warm transcript bookkeeping precedes the final budget.** `warm-transcript.ts:46` marks the source window seen; `prompt-assembly.ts:1017` subsequently bounds it. “Seen” therefore includes rows withheld by the byte budget, not strictly rows the model received. The prompt includes an omission notice and fetch pointers, but the cache semantics deserve follow-up if older messages must be restored automatically. Left unchanged: fixing this needs a delivery acknowledgement shared by both turn runners, including retries and truncated-row identity. Simply replaying everything would remove the existing token-saving behavior. The current behavior was inspected, not reproduced as a user-visible failure.

5. **Native persisted-session support is not connected to these monolith turn runners.** `acp.ts:1654` defines `openAcpConversation` and a native-load fallback. The Room runner calls `sessionNew` directly (`monolith-room-turn.ts:1268`); the corner runner similarly creates sessions. Warm process retention works, but eviction/restart must not be described as automatically restoring the full provider conversation in these paths. Left intact: wiring native loads needs model/soul/permissions/session-currency invalidation proofs, not just changing the constructor. Bounded transcript replay is the current recovery mechanism.

## Exact prompt text and token measurements

`before.json` and `after.json` contain the complete **Beeline-authored text** for the captured fixtures. `capture.ts` renders source builders and extracts `docs/prompts/*.md` snapshots. `count.py` measures strings with **tiktoken 0.14.0 / o200k_base**, including separators; `tokens.json` is the machine-readable result. These are exact counts for that encoding, not bytes/4 estimates or provider bills. Claude/Grok/Pi tokenizers, tool schema overhead, native harness instructions, real souls, repository AGENTS.md, images, tool results and arbitrary task/brief text are outside these fixture counts. No live prompt or secret was captured.

Session snapshots use their existing deterministic host, soul, branch and 8 GiB fixtures. Synthetic wake fixtures use a tiny widget assignment, with no history, roster, memory or attachments. The combined review row joins the reviewer session snapshot and target instruction; it is not an observed production turn. Full inputs are in `capture.ts`. Do not compare different rows as if their variable context were identical.

| Prompt fixture | Before | After | Saved |
| --- | ---: | ---: | ---: |
| Room session | 1057 | 1017 | 40 |
| DM session | 773 | 743 | 30 |
| Code corner, reviewed | 1469 | 1431 | 38 |
| Code corner, no reviewer | 1467 | 1429 | 38 |
| Code corner, REST gh | 1503 | 1465 | 38 |
| Code corner, Android | 1560 | 1522 | 38 |
| Code corner, reviewer | 1503 | 1465 | 38 |
| Code corner, runtime-only assignment | 1068 | 1030 | 38 |
| Repo-less corner session | 796 | 758 | 38 |
| Room turn, facts only | 108 | 108 | 0 |
| Corner turn, facts only | 115 | 115 | 0 |
| Room order wake, Codex prefix | 952 | 912 | 40 |
| Room report wake, Codex prefix | 951 | 911 | 40 |
| Corner human wake, Codex prefix | 1441 | 1403 | 38 |
| Corner checks wake, Codex prefix | 1523 | 1485 | 38 |
| Corner land wake, Codex prefix | 1470 | 1432 | 38 |
| Corner order wake, Codex prefix | 1441 | 1403 | 38 |
| Corner report wake, Codex prefix | 1443 | 1405 | 38 |
| Reviewer target instruction | 144 | 144 | 0 |
| Reviewer session + target | 1647 | 1609 | 38 |
| Checks nudge | 68 | 68 | 0 |
| Delivery nudge | 116 | 116 | 0 |

The exact target SHA and revision are tool arguments/facts, not navigation text. Review instructions require current green-head proof and `approve_merge`; implementer landing requires `merge_corner`. Reviewed and runtime-only assignments need different instructions; reviewer-authors still need conditional implementer rules because they can be explicitly ordered to write code. Those role/capability distinctions were preserved.

## What reaches the model at each step

`prompt-assembly.ts` is the assembly authority. `SESSION_SECTIONS` provides identity/soul/host, resource cap, completion, truth, reply shape, coordination, authority, feedback and attachments, followed by the surface rules. Room rules explain read-only checkout, corner creation, watches and reply discipline. DM rules explain its address scope. Code corners add worktree, conditional preparation/push, brief author contract, checks, merge and optional reviewer/Android rules. Repo-less corners get writable artifacts and no GitHub workflow.

`harness-capabilities.ts:165` recognizes Claude's system-prompt delivery; `acp.ts:1086` supplies its `_meta.systemPrompt` append. Claude gets those rules at session creation and subsequent turn facts without the prefix. Codex, Pi, Grok and unverified commands get the rules again as `turn.session` at the top of each full turn. This repetition is required by the measured adapter contract, not removable duplication. The reduction saves 30–40 tokens once per Claude session and per full prefixed turn for the other harnesses. Cache discounts and lifetime spend were not inferred.

Each Room/DM turn fetches conversation (200-row request, last 80 eligible transcript rows), roster, attachment delivery, corner list and optional institutional context (`monolith-room-turn.ts:1555`). It adds checkout commit, selected transcript, card resume context when relevant, exact member handles, memory, open/recently closed corners and the current task. The source task is excluded from history to avoid repeating it. Repository checkout is refreshed; stable rules stay session-owned.

Each corner turn fetches its own conversation and live configuration/brief/files. It selects the last 120 eligible transcript rows, then adds objective, generated-name instruction when needed, current brief/approval/files, member directory, memory, sibling corners, live reviewer target and the newest task (`monolith-corner-turn.ts:1682`). Delivery follow-ups carry a brief plus nudge instead of the entire original context. A checks wake has silence/log instructions; a land wake says the current head was approved. User schedules retain ordinary reporting. Reviewer green-head instructions override stale target text in history.

Orders and reports are `agent_commands.private_payload`, not extra public transcript rows (`server/commander.ts:215`). `agent-command.ts:1334` projects the payload text into the private source message; ordinary turn assembly then renders it as the current task. There is no separate giant “order prompt” or “report prompt.” Lifecycle wakes preserve the active order's provenance (`agent-command.ts:347`). `core.finish` tells an agent to end after ordering; the private report wakes another turn. This is efficient and already avoids conversation polling. Tool descriptions hold tool-specific mechanics; skills hold long procedures and are loaded when the task calls for them.

## Memory: persistence, reads and cost

| State | Lifetime / read behavior | Cost and limits |
| --- | --- | --- |
| Live harness conversation | Same resident ACP session; retained by scheduler | Native history/tool results accumulate; model compaction is harness-owned. Four idle sessions by default, 30-minute idle window; per-Room live cap 10 (`session-scheduler.ts:66–105`). These are code defaults, not measured live usage. |
| Warm transcript IDs | One session id; cold id/re-pin resets | Omits already-seen rows and warm self replies; tracks IDs rather than transcript text (`warm-transcript.ts`). |
| Section baseline | One session id; cold activation resets | Keeps hashes, never text; observes unchanged/changed sections (`prompt-section-baseline.ts`). |
| Turn history | Re-read from server every turn/attempt | Default context 32,768 tokens. Budget reserves max(4096, 30% of context); transcript capped at min(24 KB, context/4 bytes, available bytes), less overhead. Individual rows max 4096 bytes, Room task max 8000 bytes; inline media stripped with fetch pointers (`transcript-budget.ts:2`). |
| Institutional snapshot | Fetched every turn, concurrent with activation | Hard max 1000 bytes; 500 ms fetch budget, fail-open with an explicit missed-context sentence (`institutional-context.ts:12`, contract `institutional-memory.ts:117`). Actual token count depends on matched text. |
| Institutional items/procedures | Durable server store, agent maintained | Search/save/update/delete/report-used are explicit calls. Agent-saved Workspace facts expire after default 90 days; explicit saves/profile facts and skills/workflows do not (`institutional-curator.ts:569`). Code anchors can stale procedures. |
| Soul / stable surface rules | Loaded at session activation | Full rules repeated in the turn prefix where the adapter drops the session system prompt. |
| Brief and manifest | Server durable revision; read and rendered per attempt | Scope/approval must remain fresh. Full text is outside warm transcript elision. |
| Local harness home/private files | Survive archive | No archive TTL in this cleanup path; retention decision outstanding. |

The bounds make a new task runnable without preloading all attachments or all Workspace procedures. Current memory notes explicitly lose to messages/code. Removing the live roster would break exact tags and handovers; removing the brief would weaken scope authority. Removing the prefixed rules would lose instruction delivery on several adapters. These larger-looking costs were deliberately retained.

## Corner closure and cleanup

| Artifact | Observed contract | Evidence |
| --- | --- | --- |
| Pending/claimed commands and working turns | Cancelled in the same archive transaction | `server/corner-close.ts:12`; shared close/merge paths |
| ACP session / registered helpers | Suspended/forgotten; Squire relay closed; grant runner unregistered; harvest awaited | `monolith-corner-turn.ts:2522` |
| Child processes | Scoped teardown contains descendants; unscoped fallback signals the process group TERM then KILL | `acp.ts:998`; isolated scope tests; systemd-specific proofs skipped here |
| Git worktree and ignored output | Removed after publication/ownership checks | `room-runtime.ts:376`; real temporary-git cleanup proofs |
| Local branch | Deleted after safe cleanup; retained on remote deletion failure for retry | Same function; idempotence tests |
| Remote branch | Deleted only with exact-ref authority and no open PR; open/unconfirmed PR branch preserved | `room-runtime.ts:1870`, `corner-pr-branch-preservation.test.ts` |
| Dirty/unpublished work | Preserved, not discarded; recovery pointer/pruning path | `room-runtime.ts:1834`; `corner-branch-sync.test.ts` |
| Repo-less scratch work files | Reaped on close; active scratch has 14-day file TTL | `room-runtime.ts:538`, `:1970`; scratch tests |
| Harness home/private data | Intentionally retained | Same scratch cleanup and local-state tests |
| Removed membership / failed reads | Not archive proof; cleanup refuses or defers | Restore-state validation and local-state tests |

No cleanup leak was reproduced by the existing isolated worktree/scratch/process fallback proofs. That does **not** establish that every production helper is leak-free or that historical retained homes are small. No live unit, real agent or emulator was used to verify lifecycle effects.

## Validation and delivery

- Prompt snapshots regenerated, then rerun without update: 100 tests pass, including four new surface regressions.
- Audit matrix: 12 files, 197 passed, 3 systemd-only tests skipped. Covers prompt assembly/baselines, warm history, transcript budgets, optional memory, archive scratch, branch synchronization/publication checks, open-PR preservation, scratch TTL and scope startup/fallback. The fallback emitted missing-user-bus diagnostics; it passed. Real-systemd descendant cleanup remains unproven in this environment.
- Body typecheck and root `npm run typecheck` pass, including mobile and script checks. `git diff --check` passes.
- Direct PR to main; no no-mistakes daemon or pipeline, no merge, no release.
- Delivery link and CI outcome will be recorded once the forge creates the PR.

Reproduce measurements after installing `tiktoken==0.14.0` into the local `.tokenizer` directory: run `node --import tsx data/beeline-audit-agent-lifecycle/capture.ts` for current text and `PYTHONPATH=data/beeline-audit-agent-lifecycle/.tokenizer python data/beeline-audit-agent-lifecycle/count.py` for the stored before/after corpus. The corpus is synthetic and safe to commit.
