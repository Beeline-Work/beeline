# Institutional memory and workflow invariants

Paths and commands below are relative to the repository root. Read these invariants before editing this area; named code and tests hold implementation detail.

## Institutional memory

- Institutional memory stays optional to every turn and is maintained by the answering agent, never background review. Only explicit `false` disables its flags. Keep context within `INSTITUTIONAL_CONTEXT_HARD_MAX_BYTES`; fetch alongside harness activation, report a miss, and bind writes to the active command. Workspace facts alone expire; code-anchored procedures stale when their blob changes, fail-open. Authority: `packages/api-contract/src/institutional-memory.ts`, `institutional-context.ts`, `institutional-curator.ts`, `institutional-skill-anchors.ts`.

## Workflow runtime

- Saved workflow format, required descriptions/timeouts, gates, failover and tools: [workflow reference](workflows/README.md), `readWorkflowContract`, `validateSavedWorkflow`. Do not duplicate that contract here.
- `apps/server/src/workflow-runs.ts` owns runtime state on message cards, with no run-state tables: start-card ID is the run ID, latest handoff is state, and `saveRunStatus` writes the start card's indexed `runStatus`. Every reader uses `workflowRunIsLiveSql`; release migration re-arms missing live timers.
- Every writer goes through `openRun` → `enterState`/`moveRole`/`closeRun` under the run lock. Attempt is the dispatch card's `seq`; stale/repeated calls return `alreadyAdvanced` without double cancellation. Starting is locked per workflow/Room with one live run; a schedule skips an existing run.
- Timers are system-owned `agent_schedules` rows carrying `workflow_run`, fired by `fireWorkflowTimer`; wakes go through `systemLine`. Failover walks ordered role lists forward once per state visit; exhaustion without a timeout outcome retries the full list after the lease. An unanswered completed attempt counts as blocked (`failOverUnansweredTurn`).
- A gate posts its choice card and leaves only on a person's answer, Skip or default; default notices go to the run owner. Close open choices when leaving a gate or ending a run (`closeRunChoices`); preserve lazy and migration sweeps. `assign_workflow_role` can rebind any role.
- Every workflow MCP tool in a corner resolves its Room with `agentScheduleRoomId()` (corner first), never the parent `BEELINE_DAEMON_ROOM_ID`. Proof: `npm run prove:workflow-run`; `apps/body/src/workflow-corner-e2e.integration.test.ts`.
