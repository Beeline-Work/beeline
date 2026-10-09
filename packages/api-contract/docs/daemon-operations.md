# Daemon API operation design

`DaemonOperationMap` in `src/daemon-operations.ts` is the typed list the monolith server and daemon client implement. It intentionally contains no `queryEvents`, `rawEvents`, `publishEvent`, or generic publish operation.

The inventory below covers all 53 production raw-query call sites and all 37 production publish call sites observed in `apps/body/src` on 2026-08-31.

## Reads: 53 raw-query call sites

| Named operation                                  | Current call sites covered                                                                             |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `listAgentToolSchedules`, `listWorkSchedules`    | `body-agent-tools.ts:757,815`; `daemon-work-calendar.ts:728,790`                                       |
| `getPermissionAuthority`                         | `daemon-work-calendar.ts:336,378,380,396,401`; `body.ts:5531,5573,5610,5654,5807,5971,6262`            |
| `getAgentToolMandate`                            | `daemon-work-calendar.ts:447,449,491,492`; `body.ts:5474,5491`                                         |
| `getWorkScheduleAuthority`                       | `daemon-work-calendar.ts:582`; authority facts are returned together, never as caller-selected filters |
| `getTargetAgentAuthority`                        | `daemon-work-calendar.ts:620,643,670,677`                                                              |
| `getRoomInbox`                                   | `body.ts:5344,8753,8986,9185,9211`; `body.ts:10965` (paged abandoned-corner inbox)                     |
| `getRoomConversation`                            | `body.ts:5654,5971`; named reads keep prompt history and bounded continuity history separate           |
| `getRoomAuthority`, `getDaemonBootstrap`         | `body.ts:2471,2490,2494,4336,4355,4362`                                                                |
| `getIdentitySuccession`                          | `body.ts:6195,10590`                                                                                   |
| `getAgentConfiguration`, `getAgentPresence`      | `body.ts:7970`; configuration/presence reads embedded in current helper calls                          |
| `getRequestCompletion`                           | `body.ts:12087`                                                                                        |
| `listCornerBriefRevisions({ cornerId, beforeRevision?, limit? })` | Newest-first brief history; default one revision plus cursor, limit 1–20 |
| `listRoomCorners`, `getCornerRestoreState`       | `body.ts:9727,9750,9796,9880,9936,10844,10900,11195,11311`                                             |
| `listUntrackedCorners`, `getCornerCloseRequests` | `body.ts:10844,10868,10965`                                                                            |
| `getRoomRepositoryState`, `getRoomTargetBranch`  | `body.ts:9185,9211`; existing higher-level repository reads remain named state reads                   |

Repeated reads in an authority check are preserved as retry semantics inside the named server operation, not exposed as repeatable raw filters. Some current call sites contribute to more than one returned aggregate; every syntactic raw read is named above at least once.

## Writes: 37 publish call sites

| Named operation                                                 | Current call sites covered                                                                                                              |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `postAgentToolScheduleIndex`, `postAgentToolMandate`            | `body-agent-tools.ts:435,808,1075,1438`                                                                                                 |
| `postWorkSchedule`, `postWorkScheduleReceipt`                   | `work-calendar.ts:802,812,904`; `daemon-work-calendar.ts:801`                                                                           |
| `postAgentCommands`                                             | `agent-commands-publish.ts:46`                                                                                                          |
| `postCornerRemoteState`, `archiveCorner`                       | `body.ts:9717,9782,9853,9918,9974`                                                                                                     |
| `watchCorner`                                                 | `read-only-mcp.ts` (`watch_corner`); transactional snapshot and sibling merge/check wakes                                                 |
| `postAgentActivity`, `postCornerPlan`                           | `activity.ts:1014,1030,1060,1088,1561`                                                                                                  |
| `postPermissionRequest`, `postPermissionExecution`              | `permission-runtime.ts:121,362`; `body.ts:5841,5932,5946,6328`                                                                          |
| `postRoomMessage`                                               | `events-service.ts:421,422,448`; `body.ts:2447,2509,4320,7940`                                                                          |
| `postAgentTurnReceipt`                                          | `body.ts:4855` and terminal receipt publication routed through `events-service.ts:448`                                                  |
| `postAgentDraft`, `postAgentThought`, `retractAgentLiveOutput`  | the four live-output publications at `activity.ts:1014,1030,1060,1088` split by their typed presentation                                |
| `postTargetBranchProposal`                                      | current typed control publication reached from `body.ts:7940`                                                                           |
| `reviseCornerBrief` | Records the full revision and returns `wake: { queued, agentId?, reason? }`; opener commands may come from the parent or a sibling via `roomId`, implementer commands from the target |
| `createCorner`, `ensureAgentMembership`                         | current higher-level channel helpers invoked by Body; their relay publications become atomic named operations rather than raw endpoints |

`events-service.ts:421` and `:422` are alternate injected/default publisher branches; `:448` is the bounded delivery attempt. They are three production publish call sites but one named domain write.

## Boundary rules for Phase B

- Authority operations return a verified decision or `unavailable`; callers never receive signed rows to reinterpret.
- Writes accept stable domain IDs and validated payloads, and return the durable server ID/time used for receipts and deduplication. `postRoomMessage` also returns the validated persisted mention IDs, so a daemon never treats an unresolved or capped target as continuity.
- Inbox and conversation reads own pagination and ordering. The caller cannot supply arbitrary kinds, authors, or tags.
- `getRoomConversation` has distinct `recent`, `earliest`, and `continuity` windows: prompt context, initial objective recovery, and bounded message-only response continuity respectively. A cursor read remains an ascending walk regardless of the selected window.
- Inbox cursors are opaque `created_at,id` positions. A daemon with no durable cursor first requests `startAtLatest` to establish its activation high-water mark without replaying imported history. Servers that return `rewindIds` support five-second replay via `rewind: true`; the daemon seeds those activation ids and de-duplicates every later delivery by id. Intake items include only server-validated addressing, reply-parent and request authors, agent-authorship and hop metadata, and attachment metadata; daemons never recover those facts from raw tags.
- Live draft/thought operations are explicitly replace/retract operations, not generic event publication.
- `postAgentActivity` keeps ordinary tool activity available on either surface, but `kind='output'` is durable corner narration and is rejected outside a corner. A corner writer binds any completed pre-tool assistant runs to that tool when the call first appears, then posts the narration and terminal tool record together only after the tool settles; the final reply remains a separate whole last assistant run.
- A corner activity write may carry a bounded deterministic `cornerActivityKey`. The server derives its message ID from the corner, agent, request, and key, and treats a conflict as a replay only when the existing row has that same corner, agent, request, activity presentation, and exact activity payload. Retried writes therefore reuse the original payload rather than creating another narration row.
- A corner helper sends the model pinned to its producing session as `agentModel` (or null when no model is known). The server stamps it on the activity row so later agent setting changes cannot relabel that turn; older helpers that omit the field retain the prior server selection fallback.

### PR check gate

`getPrChecksStatus({ cornerId, pullRequest? })` is authorized by current corner membership.
`pullRequest` is a positive PR number in the parent Room repository or its full GitHub URL;
omitting it selects the corner's own PR. It returns facts only: `stage` (`building` |
`checking` | `waiting_for_yes` | `merged` | `closed`, derived from the live facts below),
`checks` (`passed`, `failed`, or `pending`, read live from GitHub's rollup for the current head),
`pullRequest` (URL), `headSha`, `checkCount`, `approved` (a yes said on this exact head: a
configured reviewer agent's PASS, or a current Workspace owner or admin), `reviewer` (the
parent Room's currently configured reviewer as `@handle`, or null), `reviewerExists`,
`reviewerWake` (`unconfigured` | `unreachable` | `waiting` | `dispatched`, plus a `detail`
sentence), `held`/`holds`, and `mergeAllowed`:

    mergeAllowed = checks === 'passed' && approved && !held

A new commit cancels the yes because it is bound to the exact head; a brief edit does not. A
hold is the only veto.

Deploy the server before helpers that call this operation.

`closeCornerPullRequest({ cornerId })` closes the corner's own pull request without merging. Any
corner member may call it. The branch stays on GitHub; the corner stays open with `lifecycle.pr`
cleared, so `mergeCorner` reports no pull request until a new one opens.

`mergeCorner({ cornerId })` is the implementer's merge. Only the corner's implementer may call it.
It goes through the one merge path, `landCorner`, which squash-merges the current head only when
`getPrChecksStatus` reports `mergeAllowed`; otherwise it attempts nothing and returns
`{ status: 'blocked', blocker }`. A reviewer's PASS wakes the implementer to call this operation;
a person's yes (`orderCornerMerge`, or the phone's `approveCornerMerge`) goes through the same
`landCorner` at once.
