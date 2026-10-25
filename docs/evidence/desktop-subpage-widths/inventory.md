# Desktop surface width inventory

Baseline: `6c2a6c1bec0fabc25862e510718ccf7882db30b1`. Initial source inventory; rendered measurements and screenshots are pending.

## Measurement contract

All widths below are CSS pixels at default UI scale. Source-derived values are explicitly labelled; they are not browser measurements. The desktop shell defaults to a 340 px Room list and adds a 76 px Workspace strip at 1360 px. Thus an uncapped app route has a 940 px / 1504 px pane at 1280 / 1920 px. Resizing, zen mode and persisted navigation width change this; browser proof must reset them. Padding and inner columns may further reduce content width.

PR #2915 remains OPEN (checked 2026-10-24). Its shared width primitive must land before implementation; do not edit its overlapping files before then. Rebase on main after it lands and refresh this baseline.

## Routes

| Surface (under `apps/mobile/sources/app/(app)/`) | Before at 1280 | Before at 1920 | Planned after | Rule / exception |
| --- | --- | --- | --- | --- |
| `beeline/agent-profile.tsx` | members profile mode; unmeasured | members profile mode; unmeasured | 640 centred | Form/detail |
| `beeline/agents.tsx` | redirect to members | redirect to members | 640 via members | Compatibility redirect; one shared roster, including profile mode |
| `beeline/browser-share.tsx` | 940 pane; inner width unmeasured | 1504 pane; inner width unmeasured | Viewer-specific cap | Exception: remote desktop aspect ratio; bound controls independently |
| `beeline/channels.tsx` | 940 pane; inner width unmeasured | 1504 pane; inner width unmeasured | 720 centred | List |
| `beeline/chat/[channelId].tsx` | 940 pane; inner width unmeasured | 1504 pane; inner width unmeasured | Owned by #2915 | Excluded chat column; no _chat-surface edits |
| `beeline/community.tsx` | 460 column (source) | 460 column (source) | 640 centred | Form/detail |
| `beeline/corner-app/[slug].tsx` | 720 content cap (source) | 720 content cap (source) | 720 retained | Exception: embedded tool, existing bounded content |
| `beeline/corners/[roomId].tsx` | 940 pane; inner width unmeasured | 1504 pane; inner width unmeasured | 720 centred | List; width owned by #2915 |
| `beeline/create-workspace.tsx` | 460 column (source) | 460 column (source) | 640 centred | Form/detail |
| `beeline/github-callback.tsx` | 940 pane; inner width unmeasured | 1504 pane; inner width unmeasured | 640 if visible | Transient callback; preserve redirect behaviour |
| `beeline/github-installation.tsx` | 940 pane; inner width unmeasured | 1504 pane; inner width unmeasured | 640 centred | Form/detail |
| `beeline/google-callback.tsx` | 940 pane; inner width unmeasured | 1504 pane; inner width unmeasured | 640 if visible | Transient callback; preserve redirect behaviour |
| `beeline/human-profile.tsx` | 940 pane; inner width unmeasured | 1504 pane; inner width unmeasured | 640 centred | Form/detail |
| `beeline/members.tsx` | 940 pane; inner width unmeasured | 1504 pane; inner width unmeasured | 640 centred | Form/detail |
| `beeline/onboarding.tsx` | mixed 320 / 420 / 440 caps (source) | mixed 320 / 420 / 440 caps (source) | 640 centred | Form/detail; preserve illustration geometry |
| `beeline/settings/identity.tsx` | 940 pane; inner width unmeasured | 1504 pane; inner width unmeasured | 640 centred | Form/detail |
| `beeline/settings/index.tsx` | identity alias; unmeasured | identity alias; unmeasured | 640 centred | Form/detail |
| `beeline/settings/schedule.tsx` | 940 pane; inner width unmeasured | 1504 pane; inner width unmeasured | 640 centred | Form/detail |
| `beeline/settings/schedules.tsx` | 940 pane; inner width unmeasured | 1504 pane; inner width unmeasured | 720 centred | List |
| `beeline/settings/subscription.tsx` | 940 pane; inner width unmeasured | 1504 pane; inner width unmeasured | 640 centred | Form/detail |
| `beeline/settings/workbench/app.tsx` | 940 pane; inner width unmeasured | 1504 pane; inner width unmeasured | 640 centred | Form/detail |
| `beeline/settings/workbench/connect-app.tsx` | 940 pane; inner width unmeasured | 1504 pane; inner width unmeasured | 640 centred | Form/detail |
| `beeline/settings/workbench/connect-signin.tsx` | 940 pane; inner width unmeasured | 1504 pane; inner width unmeasured | 640 centred | Form/detail |
| `beeline/settings/workbench/connect.tsx` | 940 pane; inner width unmeasured | 1504 pane; inner width unmeasured | 640 centred | Form/detail |
| `beeline/settings/workbench/connection.tsx` | 940 pane; inner width unmeasured | 1504 pane; inner width unmeasured | 640 centred | Form/detail |
| `beeline/settings/workbench/service.tsx` | 940 pane; inner width unmeasured | 1504 pane; inner width unmeasured | 640 centred | Form/detail |
| `beeline/settings/workbench/wallet-receive.tsx` | 940 pane; inner width unmeasured | 1504 pane; inner width unmeasured | 640 centred | Form/detail |
| `beeline/settings/workbench/wallet-send.tsx` | 940 pane; inner width unmeasured | 1504 pane; inner width unmeasured | 640 centred | Form/detail |
| `beeline/settings/workbench/wallet-service.tsx` | 940 pane; inner width unmeasured | 1504 pane; inner width unmeasured | 640 centred | Form/detail |
| `beeline/settings/workbench/wallet.tsx` | 940 pane; inner width unmeasured | 1504 pane; inner width unmeasured | 640 centred | Form/detail |
| `beeline/settings/workbench.tsx` | 940 pane; inner width unmeasured | 1504 pane; inner width unmeasured | 640 centred | Form/detail |
| `beeline/settings/workflows.tsx` | 940 pane; inner width unmeasured | 1504 pane; inner width unmeasured | 720 centred | List |
| `beeline/settings/workspace.tsx` | 940 pane; inner width unmeasured | 1504 pane; inner width unmeasured | 640 centred | Form/detail |
| `beeline/tray.tsx` | 390 list cap + detail pane (source) | 390 list cap + detail pane (source) | 720 list | List; review existing split detail layout |
| `beeline/workflow-run.tsx` | 940 pane; inner width unmeasured | 1504 pane; inner width unmeasured | 720 centred | Workflow run ledger |
| `beeline/workflow.tsx` | 940 pane; inner width unmeasured | 1504 pane; inner width unmeasured | 640 centred | Form/detail |
| `join/[token].tsx` | 460 column (source) | 460 column (source) | 640 centred | Join form |

## Modal manager placements

`Modal.show` accepts center, bottom and fill. `pane` / `primary` are workbench transition results, not ModalManager placements. All production call sites below currently use fill.

| Call site | Before at 1280 | Before at 1920 | Planned after | Rule / exception |
| --- | --- | --- | --- | --- |
| `app/(app)/beeline/chat/RoomMessageVariants.tsx:721` | 1280 outer fill (source) | 1920 outer fill (source) | Viewer-specific content cap | Full-screen viewer; inspect controls and content separately |
| `components/buzz/ArtifactCard.tsx:69` | 1280 outer fill (source) | 1920 outer fill (source) | Viewer-specific content cap | Full-screen viewer; inspect controls and content separately |
| `components/buzz/ComputerSession.tsx:188` | 1280 outer fill (source) | 1920 outer fill (source) | Viewer-specific content cap | Full-screen viewer; inspect controls and content separately |
| `components/buzz/corner-brief-viewer.ts:11` | 1280 outer fill (source) | 1920 outer fill (source) | Viewer-specific content cap | Full-screen viewer; inspect controls and content separately |

## Sheet and dialog instances

The shared `HullActionSheetModal` already uses center on desktop (460 px source cap), bottom on phones. Its body height budgeting applies only when sticky chrome or footer props are supplied. Direct HullModal callers require separate placement review. `HullDialog` and Modal.confirm / alert / prompt use a 460 px centred surface, within the requested small-dialog range.

| Instance | Before at 1280 | Before at 1920 | Planned after | Rule / exception |
| --- | --- | --- | --- | --- |
| `app/(app)/beeline/chat/_chat-surface.tsx:6968` (HullActionSheetModal) | 460 cap (source; overrides unmeasured) | 460 cap (source; overrides unmeasured) | ≤560 centred; ≤82% height | Sheet; internal scrolling |
| `app/(app)/beeline/chat/_chat-surface.tsx:7135` (HullActionSheetModal) | 460 cap (source; overrides unmeasured) | 460 cap (source; overrides unmeasured) | ≤560 centred; ≤82% height | Sheet; internal scrolling |
| `app/(app)/beeline/chat/_chat-surface.tsx:7266` (HullActionSheetModal) | 460 cap (source; overrides unmeasured) | 460 cap (source; overrides unmeasured) | ≤560 centred; ≤82% height | Sheet; internal scrolling |
| `app/(app)/beeline/chat/_chat-surface.tsx:7337` (HullDialog) | 460 cap (source) | 460 cap (source) | 460 retained | Small dialog; preserve focus and Escape |
| `app/(app)/beeline/members.tsx:1139` (HullActionSheetModal) | 460 cap (source; overrides unmeasured) | 460 cap (source; overrides unmeasured) | ≤560 centred; ≤82% height | Sheet; internal scrolling |
| `app/(app)/beeline/settings/workbench/app.tsx:128` (HullActionSheetModal) | 460 cap (source; overrides unmeasured) | 460 cap (source; overrides unmeasured) | ≤560 centred; ≤82% height | Sheet; internal scrolling |
| `app/(app)/beeline/settings/workbench/connect-app.tsx:69` (HullActionSheetModal) | 460 cap (source; overrides unmeasured) | 460 cap (source; overrides unmeasured) | ≤560 centred; ≤82% height | Sheet; internal scrolling |
| `app/(app)/beeline/settings/workbench/service.tsx:169` (HullActionSheetModal) | 460 cap (source; overrides unmeasured) | 460 cap (source; overrides unmeasured) | ≤560 centred; ≤82% height | Sheet; internal scrolling |
| `app/(app)/beeline/settings/workbench/service.tsx:174` (HullActionSheetModal) | 460 cap (source; overrides unmeasured) | 460 cap (source; overrides unmeasured) | ≤560 centred; ≤82% height | Sheet; internal scrolling |
| `app/(app)/text-selection.tsx:122` (HullDialog) | 460 cap (source) | 460 cap (source) | 460 retained | Small dialog; preserve focus and Escape |
| `buzz/wallet-send-form.tsx:121` (HullActionSheetModal) | 460 cap (source; overrides unmeasured) | 460 cap (source; overrides unmeasured) | ≤560 centred; ≤82% height | Sheet; internal scrolling |
| `components/buzz/AppearanceSetting.tsx:39` (HullActionSheetModal) | 460 cap (source; overrides unmeasured) | 460 cap (source; overrides unmeasured) | ≤560 centred; ≤82% height | Sheet; internal scrolling |
| `components/buzz/AttachmentPickerSheet.tsx:44` (HullDialog) | 460 cap (source) | 460 cap (source) | 460 retained | Small dialog; preserve focus and Escape |
| `components/buzz/AttachmentPickerSheet.tsx:78` (HullActionSheetModal) | 460 cap (source; overrides unmeasured) | 460 cap (source; overrides unmeasured) | ≤560 centred; ≤82% height | Sheet; internal scrolling |
| `components/buzz/ConversationComposer.tsx:718` (HullDialog) | 460 cap (source) | 460 cap (source) | 460 retained | Small dialog; preserve focus and Escape |
| `components/buzz/CornerActionsSheet.tsx:63` (HullActionSheetModal) | 460 cap (source; overrides unmeasured) | 460 cap (source; overrides unmeasured) | ≤560 centred; ≤82% height | Sheet; internal scrolling |
| `components/buzz/CornerObjectiveLine.tsx:111` (HullActionSheetModal) | 460 cap (source; overrides unmeasured) | 460 cap (source; overrides unmeasured) | ≤560 centred; ≤82% height | Sheet; internal scrolling |
| `components/buzz/CreatePollSheet.tsx:50` (HullActionSheetModal) | 460 cap (source; overrides unmeasured) | 460 cap (source; overrides unmeasured) | ≤560 centred; ≤82% height | Sheet; internal scrolling |
| `components/buzz/DirectMessagePickerSheet.tsx:42` (HullActionSheetModal) | 460 cap (source; overrides unmeasured) | 460 cap (source; overrides unmeasured) | ≤560 centred; ≤82% height | Sheet; internal scrolling |
| `components/buzz/FacePickerSheet.tsx:55` (HullActionSheetModal) | 460 cap (source; overrides unmeasured) | 460 cap (source; overrides unmeasured) | ≤560 centred; ≤82% height | Sheet; internal scrolling |
| `components/buzz/ForwardCornerSheet.tsx:17` (HullDialog) | 460 cap (source) | 460 cap (source) | 460 retained | Small dialog; preserve focus and Escape |
| `components/buzz/ForwardMessagePickerSheet.tsx:53` (HullActionSheetModal) | 460 cap (source; overrides unmeasured) | 460 cap (source; overrides unmeasured) | ≤560 centred; ≤82% height | Sheet; internal scrolling |
| `components/buzz/HullMenuTrigger.tsx:58` (HullActionSheetModal) | 460 cap (source; overrides unmeasured) | 460 cap (source; overrides unmeasured) | ≤560 centred; ≤82% height | Sheet; internal scrolling |
| `components/buzz/MemberPickerSheet.tsx:105` (HullActionSheetModal) | 460 cap (source; overrides unmeasured) | 460 cap (source; overrides unmeasured) | ≤560 centred; ≤82% height | Sheet; internal scrolling |
| `components/buzz/MessageReactionRoster.tsx:129` (HullActionSheetModal) | 460 cap (source; overrides unmeasured) | 460 cap (source; overrides unmeasured) | ≤560 centred; ≤82% height | Sheet; internal scrolling |
| `components/buzz/NewCornerDialog.tsx:34` (HullDialog) | 460 cap (source) | 460 cap (source) | 460 retained | Small dialog; preserve focus and Escape |
| `components/buzz/NewRoomDialog.tsx:175` (HullActionSheetModal) | 460 cap (source; overrides unmeasured) | 460 cap (source; overrides unmeasured) | ≤560 centred; ≤82% height | Sheet; internal scrolling |
| `components/buzz/PushLevelSetting.tsx:62` (HullActionSheetModal) | 460 cap (source; overrides unmeasured) | 460 cap (source; overrides unmeasured) | ≤560 centred; ≤82% height | Sheet; internal scrolling |
| `components/buzz/RoomDeckComposeMenu.tsx:112` (HullActionSheetModal) | 460 cap (source; overrides unmeasured) | 460 cap (source; overrides unmeasured) | ≤560 centred; ≤82% height | Sheet; internal scrolling |
| `components/buzz/RoomReviewerActions.tsx:167` (HullActionSheetModal) | 460 cap (source; overrides unmeasured) | 460 cap (source; overrides unmeasured) | ≤560 centred; ≤82% height | Sheet; internal scrolling |
| `components/buzz/RoomRosterSheet.tsx:122` (HullActionSheetModal) | 460 cap (source; overrides unmeasured) | 460 cap (source; overrides unmeasured) | ≤560 centred; ≤82% height | Sheet; internal scrolling |
| `components/buzz/ToolOutputSheet.tsx:73` (HullActionSheetModal) | 460 cap (source; overrides unmeasured) | 460 cap (source; overrides unmeasured) | ≤560 centred; ≤82% height | Sheet; internal scrolling |
| `components/buzz/UiSizeSetting.tsx:39` (HullActionSheetModal) | 460 cap (source; overrides unmeasured) | 460 cap (source; overrides unmeasured) | ≤560 centred; ≤82% height | Sheet; internal scrolling |
| `components/buzz/WorkspaceActionsMenu.tsx:41` (HullActionSheetModal) | 460 cap (source; overrides unmeasured) | 460 cap (source; overrides unmeasured) | ≤560 centred; ≤82% height | Sheet; internal scrolling |
| `components/buzz/WorkspaceSettingsPanel.tsx:72` (HullDialog) | 460 cap (source) | 460 cap (source) | 460 retained | Small dialog; preserve focus and Escape |
| `components/buzz/WorkspaceSettingsPanel.tsx:662` (HullActionSheetModal) | 460 cap (source; overrides unmeasured) | 460 cap (source; overrides unmeasured) | ≤560 centred; ≤82% height | Sheet; internal scrolling |
| `components/buzz/WorkspaceSettingsPanel.tsx:687` (HullActionSheetModal) | 460 cap (source; overrides unmeasured) | 460 cap (source; overrides unmeasured) | ≤560 centred; ≤82% height | Sheet; internal scrolling |
| `modal/ModalProvider.tsx:120` (HullActionSheetModal) | 460 cap (source; overrides unmeasured) | 460 cap (source; overrides unmeasured) | ≤560 centred; ≤82% height | Sheet; internal scrolling |
| `modal/components/BaseModal.tsx:25` (HullModal) | placement-dependent; unmeasured | placement-dependent; unmeasured | ≤560 sheet / 460 dialog / bounded viewer | Inspect direct placement and contentStyle |
| `modal/components/WebAlertModal.tsx:55` (HullDialog) | 460 cap (source) | 460 cap (source) | 460 retained | Small dialog; preserve focus and Escape |
| `modal/components/WebPromptModal.tsx:36` (HullDialog) | 460 cap (source) | 460 cap (source) | 460 retained | Small dialog; preserve focus and Escape |

## Shared confirm and picker entry points

| Entry point | Before at 1280 / 1920 | Planned after | Rule |
| --- | --- | --- | --- |
| Modal.confirm / Modal.alert → WebAlertModal | 460 / 460 cap (source) | 460 / 460 | Centred small dialog |
| Modal.prompt → WebPromptModal | 460 / 460 cap (source) | 460 / 460 | Centred small input dialog |
| Modal.actionSheet → WebAlertModal action-sheet mode | HullActionSheetModal; 460 / 460 cap (source) | ≤560 centred | Shared action menu |

## Remaining proof before implementation / PR

- Replace unmeasured entries with rendered bounding boxes at both desktop widths; inspect delegated components and style overrides.
- Capture members, a profile, tray, two sheets and a confirm before and after at both widths; capture phone page and sheet unchanged.
- Exercise the signed-in production web path using the reviewer bypass, then the affected built app path.
- Reproduction identifier is pending a rendered failure; this source audit alone does not prove a visible defect.
- Rebase after #2915 lands, reuse its primitive, and retain the inventory as the first standalone commit.
- Run sheet placement regressions, the mobile suite and server shard before a push. No implementation or push has occurred.
