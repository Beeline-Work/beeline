# Daemon API operation design

Phase A replaces raw event access on paper only. `DaemonOperationMap` in `src/daemon-operations.ts` is the typed list the future server must implement. It intentionally contains no `queryEvents`, `rawEvents`, `publishEvent`, or generic publish operation.

The inventory below covers all 53 production raw-query call sites and all 37 production publish call sites observed in `apps/body/src` on 2026-08-31.

## Reads: 53 raw-query call sites

| Named operation                                  | Current call sites covered                                                                             |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `listAgentToolSchedules`, `listWorkSchedules`    | `body-agent-tools.ts:757,815`; `daemon-work-calendar.ts:728,790`                                       |
| `getPermissionAuthority`                         | `daemon-work-calendar.ts:336,378,380,396,401`; `body.ts:5457,5499,5536,5580,5733,5897,6188`            |
| `getAgentToolMandate`                            | `daemon-work-calendar.ts:447,449,491,492`; `body.ts:5400,5417`                                         |
| `getWorkScheduleAuthority`                       | `daemon-work-calendar.ts:582`; authority facts are returned together, never as caller-selected filters |
| `getTargetAgentAuthority`                        | `daemon-work-calendar.ts:620,643,670,677`                                                              |
| `getRoomInbox`                                   | `body.ts:5270,8679,8912,9111,9137`; `body.ts:10891` (paged abandoned-corner inbox)                     |
| `getRoomConversation`                            | `body.ts:5580,5897`; prompt history remains a named conversation read                                  |
| `getRoomAuthority`, `getDaemonBootstrap`         | `body.ts:2468,2487,2491,4262,4281,4288`                                                                |
| `getIdentitySuccession`                          | `body.ts:6121,10516`                                                                                   |
| `getAgentConfiguration`, `getAgentPresence`      | `body.ts:7896`; configuration/presence reads embedded in current helper calls                          |
| `getRequestCompletion`                           | `body.ts:12013`                                                                                        |
| `listRoomCorners`, `getCornerRestoreState`       | `body.ts:9653,9676,9722,9806,9862,10770,10826,11121,11237`                                             |
| `listUntrackedCorners`, `getCornerCloseRequests` | `body.ts:10770,10794,10891`                                                                            |
| `getRoomRepositoryState`, `getRoomTargetBranch`  | `body.ts:9111,9137`; existing higher-level repository reads remain named state reads                   |

Repeated reads in an authority check are preserved as retry semantics inside the named server operation, not exposed as repeatable raw filters. Some current call sites contribute to more than one returned aggregate; every syntactic raw read is named above at least once.

## Writes: 37 publish call sites

| Named operation                                                 | Current call sites covered                                                                                                              |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `postAgentToolScheduleIndex`, `postAgentToolMandate`            | `body-agent-tools.ts:435,808,1075,1438`                                                                                                 |
| `postWorkSchedule`, `postWorkScheduleReceipt`                   | `work-calendar.ts:802,812,904`; `daemon-work-calendar.ts:801`                                                                           |
| `postAgentCommands`                                             | `agent-commands-publish.ts:46`                                                                                                          |
| `postCornerLifecycle`, `postCornerRemoteState`, `archiveCorner` | `lifecycle-publisher.ts:103,184,263,291`; `body.ts:9643,9708,9779,9844,9900`                                                            |
| `postAgentActivity`, `postCornerPlan`                           | `activity.ts:1014,1030,1060,1088,1561`                                                                                                  |
| `postPermissionRequest`, `postPermissionExecution`              | `permission-runtime.ts:121,362`; `body.ts:5767,5858,5872,6254`                                                                          |
| `postRoomMessage`                                               | `events-service.ts:421,422,448`; `body.ts:2444,2506,4246,7866`                                                                          |
| `postAgentTurnReceipt`                                          | `body.ts:4781` and terminal receipt publication routed through `events-service.ts:448`                                                  |
| `postAgentDraft`, `postAgentThought`, `retractAgentLiveOutput`  | the four live-output publications at `activity.ts:1014,1030,1060,1088` split by their typed presentation                                |
| `postTargetBranchProposal`                                      | current typed control publication reached from `body.ts:7866`                                                                           |
| `createCorner`, `ensureAgentMembership`                         | current higher-level channel helpers invoked by Body; their relay publications become atomic named operations rather than raw endpoints |

`events-service.ts:421` and `:422` are alternate injected/default publisher branches; `:448` is the bounded delivery attempt. They are three production publish call sites but one named domain write.

## Boundary rules for Phase B

- Authority operations return a verified decision or `unavailable`; callers never receive signed rows to reinterpret.
- Writes accept stable domain IDs and validated payloads, and return the durable server ID/time used for receipts and deduplication.
- Inbox and conversation reads own pagination and ordering. The caller cannot supply arbitrary kinds, authors, or tags.
- Live draft/thought operations are explicitly replace/retract operations, not generic event publication.
