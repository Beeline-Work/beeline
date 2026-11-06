# Institutional memory and workflow invariants

Paths and commands below are relative to the repository root. Read these invariants before editing this area; named code and tests hold implementation detail.

## Institutional memory

- Institutional memory stays optional to every turn and is maintained by the answering agent, never background review. Only explicit `false` disables its flags. Keep context within `INSTITUTIONAL_CONTEXT_HARD_MAX_BYTES`; fetch alongside harness activation, report a miss, and bind writes to the active command. Workspace facts alone expire; code-anchored procedures stale when their blob changes, fail-open. Authority: `packages/api-contract/src/institutional-memory.ts`, `institutional-context.ts`, `institutional-curator.ts`, `institutional-skill-anchors.ts`.

- Save-time document embeddings make one attempt for the exact memory item or skill version. Failure leaves missing embedding evidence intact; a later save can admit another attempt. Conditional version writes reject a result made stale by an edit. `institutional-memory-embeddings.ts` and its tests own this contract. Startup does not backfill old rows.

## Workflow runtime

- Saved workflow format, descriptions, event transitions, gates, failover and tools: [workflow reference](workflows/README.md), `readWorkflowContract`, `validateSavedWorkflow`. Do not duplicate that contract here.
- `apps/server/src/workflow-runs.ts` owns runtime state on message cards, with no run-state tables: start-card ID is the run ID, latest handoff is state, and `saveRunStatus` writes the start card's indexed `runStatus`. Every reader uses `workflowRunIsLiveSql`; idle time does not advance runs.
- Every writer goes through `openRun` → `enterState`/`moveRole`/`closeRun` after claiming the observed head revision (`claimWorkflowTransition`). Attempt is the dispatch card's `seq`; stale/repeated calls return `alreadyAdvanced` without double cancellation. A native unique key allows one live run per workflow/Room; a schedule skips an existing run.
- Only owner-created schedules have a time source (`owner-schedule-clock.ts`). Internal step, gate and deadline schedules are retired on upgrade. Workflow transitions follow explicit handoffs, decisions and role reassignments; exhaustion waits for an explicit reassignment. `agent-schedule-source.ts` publishes committed calendar and eligibility changes through the completion channel. Coverage: `background-retirement.test.ts`, `agent-schedules.test.ts`, `workflow-runs.recovery.test.ts`.
- A gate posts its choice card and leaves only on a person's answer, Skip or default; default notices go to the run owner. Close open choices when leaving a gate or ending a run (`closeRunChoices`); preserve decision-time validation. `app_tool(app:beeline:workflow,tool:rebind,args)` can rebind any role.
- Every workflow MCP tool in a corner resolves its Room with `agentScheduleRoomId()` (corner first), never the parent `BEELINE_DAEMON_ROOM_ID`.

- New schedule and event-subscription wakes require a `title` (one to four words). Event subscriptions also require `when`, a model-written trigger phrase of one to five words, stored on `agent_subscriptions`. Older rows retain derived display names and triggers; no backfill is needed. The mobile list shows name, local-time trigger, then agent and call site; workflow links stay under Does on details.

- Agents explicitly pause or resume their own schedules and subscriptions through `agent-wake-pause.ts`. `paused_at` fences every ingress; resuming preserves interval phase and skips missed occurrences. Owner inactivity creates no warning or automatic pause.
