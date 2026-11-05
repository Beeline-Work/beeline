# Work authority consolidation inventory (2026-11-04)

Sites refer to the starting revision. No capability exception is retained merely to avoid migration.

| Door | Starting sites | Decision and evidence |
| --- | --- | --- |
| MCP implicit order claim | `rooms-mcp-agent.ts:296-319` | Remove SQL claim; use command-owner claim. Its selection is ingress routing, not a separate authority. |
| MCP explicit commandId claim | `rooms-mcp-agent.ts:396-413` | Remove SQL claim; retain connected-app generation reuse through the same claim owner, so multiple tools can serve one order. |
| MCP turn start/end and direct fallback | `rooms-mcp-agent.ts:344-369` | Remove start and direct terminal fallback; canonical claim creates the working turn and canonical receipt settles it. Failed reports release their order through command-owner settlement. |
| MCP queued-wake dismissal | `rooms-mcp-agent.ts:483-507` | Keep the behavior, remove the SQL door: explicit inbox acknowledgement needs no running turn, but orders must be answered by report. Selection and settlement now belong to `dismissAgentCommandWakes` and `settleAgentCommand`; the transport cannot write command/turn rows. |
| Explicit connected-app command creation | `agent-command.ts:636-650` | Keep: an explicit app call needs its own command before it can be claimed, with historical requester/depth provenance and without notifying a helper. Creation remains in the command owner and immediately uses its claim function. |
| Legacy subscribe_events storage/dispatch | `daemon-service.ts:5985-6007`, `system-line.ts:339-355,456-460` | Remove runtime JSON authority. Old API remains an adapter to agent_subscriptions, preserving direct-event wake text for prompt-free subscriptions. |
| Parallel subscription list/delete | `agent-subscriptions.ts:130-143,324-341` | Remove legacy store paths; preserve old subscription identifiers only as wire adapters to the same store. |
| Inherited corner subscription preferences | `corner-person-state.ts:39-41,93-101` | Keep inheritance and explicit empty override: corners derive access and default preferences from their parent. The effective subscription projection reads the single store; an override flag is preference, not another action list. |
| Reviewer and free-agent subscription policies | `membership-join.ts:285-355,395-410,446-451,472-501`, `free-agents.ts:463` | Keep policy; migrate writes/reads onto the subscription owner and single store. |
| Upgrade cleanup of already archived data | `corner-close.ts:66-95`, `migrations/archived-corner-wakes.ts:5`, `database.ts:3636` | Keep: these repair assignments, old stops, wakes and holds on records archived before the common owner existed. They do not create another archival transition. Existing release-migration comments explain the boundary. |
| Normal close cleanup | `corner-close.ts:122-147` | Extract one transactional archive cleanup; close retains its closed-specific lifecycle transition. |
| Merge cleanup | `github-operations.ts:2733-2749` | Remove duplicate sequence; use shared archive cleanup. Keep locked standing corners active and keep merged-specific lifecycle data, as required by corner authority documentation. |

Guard scope: command claims, subscription authority and corner archival require one named owner at zero external allowance, including additional sinks inside owner files. Negative guard fixtures must demonstrate rejection.

Additional guard-discovered policies: `turn-silence-notice.ts:59` corrected a completed model-capacity diagnostic by directly restoring `claimed`. The correction remains necessary (the existing bounded retry is user-visible), but now calls the command claim owner with a diagnostic-specific, same-generation recovery mode; it retains cancellation and owner fences. `daemon-service.ts:1130` renewed legacy/MCP leases; that necessary progress operation now uses a generation-fenced command-owner function. The guard covers non-null owner/generation/lease assignments as well as state acquisition.

The obsolete free-agent leave repair (`free-agents.ts:449-485,988`) was another direct subscriber-to-command path. Its wake behavior is required, but its loop is removed. Both leave producers (`phone-service.ts:6975-6981,7054-7061` at consolidation) wrote unkinded facts, so they now declare `kind: left` and dispatch through systemLine's single-store lookup immediately. `free-agents.test.ts` checks delivery before a sweep and no duplicate afterward. Old membership JSON remains upgrade input only, never runtime dispatch authority.

The old free-agent leave sweep also covered recent unkinded facts from the preceding server image. That ten-minute recovery requirement is retained only in the subscription owner's upgrade import (`recoverRecentLeaveFacts`), using the single store and normal command routing, with duplicate suppression; it is no longer a runtime subscription dispatcher. The free-agent regression exercises that import twice.

`left` was present in free-agent membership lists but absent from the shared server-event catalog. It is now a registered, subscribable event in `packages/api-contract/src/system-events.ts`, and both existing leave producers declare it. This formalizes the supported leave wake rather than dropping it during migration; the shared catalog and free-agent behavioral suites cover it. Older phone message parsing already omits an unknown optional system-event field while preserving the message text (`phone-guards.ts`), so no second wire dispatcher is needed.

Room-event dispatch captures each subscription's direct/prompted mode once under row locks, after the fact INSERT to preserve the existing message-before-subscription lock order. A provisional wake count is finalized transactionally and rechecked against the cascade budget. A savepoint preserves explicit fact delivery if subscription SQL fails. Regression coverage includes a prompt edit after capture, real failed SQL, and subscribed-wake budget rollback.
