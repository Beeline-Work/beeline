# Desktop surface width inventory

Baseline: `6c2a6c1bec0fabc25862e510718ccf7882db30b1`. Initial source inventory; rendered measurements and screenshots are pending.

## Measurement contract

All widths below are CSS pixels at default UI scale. Source-derived values are explicitly labelled; they are not browser measurements. The desktop shell defaults to a 340 px Room list and adds a 76 px Workspace strip at 1360 px. Thus an uncapped app route has a 940 px / 1024 px / 1504 px pane at 1280 / 1440 / 1920 px. Resizing, zen mode and persisted navigation width change this; browser proof must reset them. Padding and inner columns may further reduce content width.

PR #2915 remains OPEN (checked 2026-10-24). Ruby subsequently ordered page-local fixes now, using temporary local width caps, without changing the shared tokens or layout files in that PR. Ruby will order the rebase and shared-width integration after it lands. This supersedes the earlier wait interpretation.

## Routes

| Surface (under `apps/mobile/sources/app/(app)/`) | Before at 1280 | Before at 1440 | Before at 1920 | Planned after | Rule / exception |
| --- | --- | --- | --- | --- | --- |
| `beeline/agent-profile.tsx` | members profile mode; unmeasured | members profile mode; unmeasured | members profile mode; unmeasured | 640 centred | Form/detail |
| `beeline/agents.tsx` | redirect to members | redirect to members | redirect to members | 640 via members | Compatibility redirect; one shared roster, including profile mode |
| `beeline/browser-share.tsx` | 940 pane; inner width unmeasured | 1024 pane; inner width unmeasured | 1504 pane; inner width unmeasured | Viewer-specific cap | Exception: remote desktop aspect ratio; bound controls independently |
| `beeline/channels.tsx` | 940 pane; inner width unmeasured | 1024 pane; inner width unmeasured | 1504 pane; inner width unmeasured | 720 centred | List |
| `beeline/chat/[channelId].tsx` | 940 pane; inner width unmeasured | 1024 pane; inner width unmeasured | 1504 pane; inner width unmeasured | Owned by #2915 | Excluded chat column; no _chat-surface edits |
| `beeline/community.tsx` | 460 column (source) | 460 column (source) | 460 column (source) | 640 centred | Form/detail |
| `beeline/corner-app/[slug].tsx` | 720 content cap (source) | 720 content cap (source) | 720 content cap (source) | 720 retained | Exception: embedded tool, existing bounded content |
| `beeline/corners/[roomId].tsx` | 940 pane; inner width unmeasured | 1024 pane; inner width unmeasured | 1504 pane; inner width unmeasured | 720 centred | List; width owned by #2915 |
| `beeline/create-workspace.tsx` | 460 column (source) | 460 column (source) | 460 column (source) | 640 centred | Form/detail |
| `beeline/github-callback.tsx` | 940 pane; inner width unmeasured | 1024 pane; inner width unmeasured | 1504 pane; inner width unmeasured | 640 if visible | Transient callback; preserve redirect behaviour |
| `beeline/github-installation.tsx` | 940 pane; inner width unmeasured | 1024 pane; inner width unmeasured | 1504 pane; inner width unmeasured | 640 centred | Form/detail |
| `beeline/google-callback.tsx` | 940 pane; inner width unmeasured | 1024 pane; inner width unmeasured | 1504 pane; inner width unmeasured | 640 if visible | Transient callback; preserve redirect behaviour |
| `beeline/human-profile.tsx` | 940 pane; inner width unmeasured | 1024 pane; inner width unmeasured | 1504 pane; inner width unmeasured | 640 centred | Form/detail |
| `beeline/members.tsx` | 940 pane; inner width unmeasured | 1024 pane; inner width unmeasured | 1504 pane; inner width unmeasured | 640 centred | Form/detail |
| `beeline/onboarding.tsx` | mixed 320 / 420 / 440 caps (source) | mixed 320 / 420 / 440 caps (source) | mixed 320 / 420 / 440 caps (source) | 640 centred | Form/detail; preserve illustration geometry |
| `beeline/settings/identity.tsx` | 940 pane; inner width unmeasured | 1024 pane; inner width unmeasured | 1504 pane; inner width unmeasured | 640 centred | Form/detail |
| `beeline/settings/index.tsx` | identity alias; unmeasured | identity alias; unmeasured | identity alias; unmeasured | 640 centred | Form/detail |
| `beeline/settings/schedule.tsx` | 940 pane; inner width unmeasured | 1024 pane; inner width unmeasured | 1504 pane; inner width unmeasured | 640 centred | Form/detail |
| `beeline/settings/schedules.tsx` | 940 pane; inner width unmeasured | 1024 pane; inner width unmeasured | 1504 pane; inner width unmeasured | 720 centred | List |
| `beeline/settings/subscription.tsx` | 940 pane; inner width unmeasured | 1024 pane; inner width unmeasured | 1504 pane; inner width unmeasured | 640 centred | Form/detail |
| `beeline/settings/workbench/app.tsx` | 940 pane; inner width unmeasured | 1024 pane; inner width unmeasured | 1504 pane; inner width unmeasured | 640 centred | Form/detail |
| `beeline/settings/workbench/connect-app.tsx` | 940 pane; inner width unmeasured | 1024 pane; inner width unmeasured | 1504 pane; inner width unmeasured | 640 centred | Form/detail |
| `beeline/settings/workbench/connect-signin.tsx` | 940 pane; inner width unmeasured | 1024 pane; inner width unmeasured | 1504 pane; inner width unmeasured | 640 centred | Form/detail |
| `beeline/settings/workbench/connect.tsx` | 940 pane; inner width unmeasured | 1024 pane; inner width unmeasured | 1504 pane; inner width unmeasured | 640 centred | Form/detail |
| `beeline/settings/workbench/connection.tsx` | 940 pane; inner width unmeasured | 1024 pane; inner width unmeasured | 1504 pane; inner width unmeasured | 640 centred | Form/detail |
| `beeline/settings/workbench/service.tsx` | 940 pane; inner width unmeasured | 1024 pane; inner width unmeasured | 1504 pane; inner width unmeasured | 640 centred | Form/detail |
| `beeline/settings/workbench/wallet-receive.tsx` | 940 pane; inner width unmeasured | 1024 pane; inner width unmeasured | 1504 pane; inner width unmeasured | 640 centred | Form/detail |
| `beeline/settings/workbench/wallet-send.tsx` | 940 pane; inner width unmeasured | 1024 pane; inner width unmeasured | 1504 pane; inner width unmeasured | 640 centred | Form/detail |
| `beeline/settings/workbench/wallet-service.tsx` | redirect to wallet | redirect to wallet | redirect to wallet | 640 via wallet | Compatibility redirect |
| `beeline/settings/workbench/wallet.tsx` | 940 pane; inner width unmeasured | 1024 pane; inner width unmeasured | 1504 pane; inner width unmeasured | 640 centred | Form/detail |
| `beeline/settings/workbench.tsx` | 940 pane; inner width unmeasured | 1024 pane; inner width unmeasured | 1504 pane; inner width unmeasured | 640 centred | Form/detail |
| `beeline/settings/workflows.tsx` | 940 pane; inner width unmeasured | 1024 pane; inner width unmeasured | 1504 pane; inner width unmeasured | 720 centred | List |
| `beeline/settings/workspace.tsx` | redirect to identity | redirect to identity | redirect to identity | 640 via identity | Compatibility redirect; PR #2915 |
| `beeline/tray.tsx` | 390 list cap + detail pane (source) | 390 list cap + detail pane (source) | 390 list cap + detail pane (source) | 720 list | List; review existing split detail layout |
| `beeline/workflow-run.tsx` | 940 pane; inner width unmeasured | 1024 pane; inner width unmeasured | 1504 pane; inner width unmeasured | 720 centred | Workflow run ledger |
| `beeline/workflow.tsx` | 940 pane; inner width unmeasured | 1024 pane; inner width unmeasured | 1504 pane; inner width unmeasured | 640 centred | Form/detail |
| `join/[token].tsx` | 460 column (source) | 460 column (source) | 460 column (source) | 640 centred | Join form |

## Modal manager placements

`Modal.show` accepts center, bottom and fill. `pane` / `primary` are workbench transition results, not ModalManager placements. All production call sites below currently use fill.

| Call site | Before at 1280 | Before at 1440 | Before at 1920 | Planned after | Rule / exception |
| --- | --- | --- | --- | --- | --- |
| `app/(app)/beeline/chat/RoomMessageVariants.tsx:721` | 1280 outer fill (source) | 1440 outer fill (source) | 1920 outer fill (source) | Viewer-specific content cap | Full-screen viewer; inspect controls and content separately |
| `components/buzz/ArtifactCard.tsx:69` | 1280 outer fill (source) | 1440 outer fill (source) | 1920 outer fill (source) | Viewer-specific content cap | Full-screen viewer; inspect controls and content separately |
| `components/buzz/ComputerSession.tsx:188` | 1280 outer fill (source) | 1440 outer fill (source) | 1920 outer fill (source) | Viewer-specific content cap | Full-screen viewer; inspect controls and content separately |
| `components/buzz/corner-brief-viewer.ts:11` | 1280 outer fill (source) | 1440 outer fill (source) | 1920 outer fill (source) | Viewer-specific content cap | Full-screen viewer; inspect controls and content separately |

## Sheet and dialog instances

The shared `HullActionSheetModal` already uses center on desktop (460 px source cap), bottom on phones. Its body height budgeting applies only when sticky chrome or footer props are supplied. Direct HullModal callers require separate placement review. `HullDialog` and Modal.confirm / alert / prompt use a 460 px centred surface, within the requested small-dialog range.

| Instance | Before at 1280 | Before at 1440 | Before at 1920 | Planned after | Rule / exception |
| --- | --- | --- | --- | --- | --- |
| `app/(app)/beeline/chat/_chat-surface.tsx:6968` (HullActionSheetModal) | 460 cap (source; overrides unmeasured) | 460 cap (source; overrides unmeasured) | 460 cap (source; overrides unmeasured) | ≤560 centred; ≤82% height | Sheet; internal scrolling |
| `app/(app)/beeline/chat/_chat-surface.tsx:7135` (HullActionSheetModal) | 460 cap (source; overrides unmeasured) | 460 cap (source; overrides unmeasured) | 460 cap (source; overrides unmeasured) | ≤560 centred; ≤82% height | Sheet; internal scrolling |
| `app/(app)/beeline/chat/_chat-surface.tsx:7266` (HullActionSheetModal) | 460 cap (source; overrides unmeasured) | 460 cap (source; overrides unmeasured) | 460 cap (source; overrides unmeasured) | ≤560 centred; ≤82% height | Sheet; internal scrolling |
| `app/(app)/beeline/chat/_chat-surface.tsx:7337` (HullDialog) | 460 cap (source) | 460 cap (source) | 460 cap (source) | 460 retained | Small dialog; preserve focus and Escape |
| `app/(app)/beeline/members.tsx:1139` (HullActionSheetModal) | 460 cap (source; overrides unmeasured) | 460 cap (source; overrides unmeasured) | 460 cap (source; overrides unmeasured) | ≤560 centred; ≤82% height | Sheet; internal scrolling |
| `app/(app)/beeline/settings/workbench/app.tsx:128` (HullActionSheetModal) | 460 cap (source; overrides unmeasured) | 460 cap (source; overrides unmeasured) | 460 cap (source; overrides unmeasured) | ≤560 centred; ≤82% height | Sheet; internal scrolling |
| `app/(app)/beeline/settings/workbench/connect-app.tsx:69` (HullActionSheetModal) | 460 cap (source; overrides unmeasured) | 460 cap (source; overrides unmeasured) | 460 cap (source; overrides unmeasured) | ≤560 centred; ≤82% height | Sheet; internal scrolling |
| `app/(app)/beeline/settings/workbench/service.tsx:169` (HullActionSheetModal) | 460 cap (source; overrides unmeasured) | 460 cap (source; overrides unmeasured) | 460 cap (source; overrides unmeasured) | ≤560 centred; ≤82% height | Sheet; internal scrolling |
| `app/(app)/beeline/settings/workbench/service.tsx:174` (HullActionSheetModal) | 460 cap (source; overrides unmeasured) | 460 cap (source; overrides unmeasured) | 460 cap (source; overrides unmeasured) | ≤560 centred; ≤82% height | Sheet; internal scrolling |
| `app/(app)/text-selection.tsx:122` (HullDialog) | 460 cap (source) | 460 cap (source) | 460 cap (source) | 460 retained | Small dialog; preserve focus and Escape |
| `buzz/wallet-send-form.tsx:121` (HullActionSheetModal) | 460 cap (source; overrides unmeasured) | 460 cap (source; overrides unmeasured) | 460 cap (source; overrides unmeasured) | ≤560 centred; ≤82% height | Sheet; internal scrolling |
| `components/buzz/AppearanceSetting.tsx:39` (HullActionSheetModal) | 460 cap (source; overrides unmeasured) | 460 cap (source; overrides unmeasured) | 460 cap (source; overrides unmeasured) | ≤560 centred; ≤82% height | Sheet; internal scrolling |
| `components/buzz/AttachmentPickerSheet.tsx:44` (HullDialog) | 460 cap (source) | 460 cap (source) | 460 cap (source) | 460 retained | Small dialog; preserve focus and Escape |
| `components/buzz/AttachmentPickerSheet.tsx:78` (HullActionSheetModal) | 460 cap (source; overrides unmeasured) | 460 cap (source; overrides unmeasured) | 460 cap (source; overrides unmeasured) | ≤560 centred; ≤82% height | Sheet; internal scrolling |
| `components/buzz/ConversationComposer.tsx:718` (HullDialog) | 460 cap (source) | 460 cap (source) | 460 cap (source) | 460 retained | Small dialog; preserve focus and Escape |
| `components/buzz/CornerActionsSheet.tsx:63` (HullActionSheetModal) | 460 cap (source; overrides unmeasured) | 460 cap (source; overrides unmeasured) | 460 cap (source; overrides unmeasured) | ≤560 centred; ≤82% height | Sheet; internal scrolling |
| `components/buzz/CornerObjectiveLine.tsx:111` (HullActionSheetModal) | 460 cap (source; overrides unmeasured) | 460 cap (source; overrides unmeasured) | 460 cap (source; overrides unmeasured) | ≤560 centred; ≤82% height | Sheet; internal scrolling |
| `components/buzz/CreatePollSheet.tsx:50` (HullActionSheetModal) | 460 cap (source; overrides unmeasured) | 460 cap (source; overrides unmeasured) | 460 cap (source; overrides unmeasured) | ≤560 centred; ≤82% height | Sheet; internal scrolling |
| `components/buzz/DirectMessagePickerSheet.tsx:42` (HullActionSheetModal) | 460 cap (source; overrides unmeasured) | 460 cap (source; overrides unmeasured) | 460 cap (source; overrides unmeasured) | ≤560 centred; ≤82% height | Sheet; internal scrolling |
| `components/buzz/FacePickerSheet.tsx:55` (HullActionSheetModal) | 460 cap (source; overrides unmeasured) | 460 cap (source; overrides unmeasured) | 460 cap (source; overrides unmeasured) | ≤560 centred; ≤82% height | Sheet; internal scrolling |
| `components/buzz/ForwardCornerSheet.tsx:17` (HullDialog) | 460 cap (source) | 460 cap (source) | 460 cap (source) | 460 retained | Small dialog; preserve focus and Escape |
| `components/buzz/ForwardMessagePickerSheet.tsx:53` (HullActionSheetModal) | 460 cap (source; overrides unmeasured) | 460 cap (source; overrides unmeasured) | 460 cap (source; overrides unmeasured) | ≤560 centred; ≤82% height | Sheet; internal scrolling |
| `components/buzz/HullMenuTrigger.tsx:58` (HullActionSheetModal) | 460 cap (source; overrides unmeasured) | 460 cap (source; overrides unmeasured) | 460 cap (source; overrides unmeasured) | ≤560 centred; ≤82% height | Sheet; internal scrolling |
| `components/buzz/MemberPickerSheet.tsx:105` (HullActionSheetModal) | 460 cap (source; overrides unmeasured) | 460 cap (source; overrides unmeasured) | 460 cap (source; overrides unmeasured) | ≤560 centred; ≤82% height | Sheet; internal scrolling |
| `components/buzz/MessageReactionRoster.tsx:129` (HullActionSheetModal) | 460 cap (source; overrides unmeasured) | 460 cap (source; overrides unmeasured) | 460 cap (source; overrides unmeasured) | ≤560 centred; ≤82% height | Sheet; internal scrolling |
| `components/buzz/NewCornerDialog.tsx:34` (HullDialog) | 460 cap (source) | 460 cap (source) | 460 cap (source) | 460 retained | Small dialog; preserve focus and Escape |
| `components/buzz/NewRoomDialog.tsx:175` (HullActionSheetModal) | 460 cap (source; overrides unmeasured) | 460 cap (source; overrides unmeasured) | 460 cap (source; overrides unmeasured) | ≤560 centred; ≤82% height | Sheet; internal scrolling |
| `components/buzz/PushLevelSetting.tsx:62` (HullActionSheetModal) | 460 cap (source; overrides unmeasured) | 460 cap (source; overrides unmeasured) | 460 cap (source; overrides unmeasured) | ≤560 centred; ≤82% height | Sheet; internal scrolling |
| `components/buzz/RoomDeckComposeMenu.tsx:112` (HullActionSheetModal) | 460 cap (source; overrides unmeasured) | 460 cap (source; overrides unmeasured) | 460 cap (source; overrides unmeasured) | ≤560 centred; ≤82% height | Sheet; internal scrolling |
| `components/buzz/RoomReviewerActions.tsx:167` (HullActionSheetModal) | 460 cap (source; overrides unmeasured) | 460 cap (source; overrides unmeasured) | 460 cap (source; overrides unmeasured) | ≤560 centred; ≤82% height | Sheet; internal scrolling |
| `components/buzz/RoomRosterSheet.tsx:122` (HullActionSheetModal) | 460 cap (source; overrides unmeasured) | 460 cap (source; overrides unmeasured) | 460 cap (source; overrides unmeasured) | ≤560 centred; ≤82% height | Sheet; internal scrolling |
| `components/buzz/ToolOutputSheet.tsx:73` (HullActionSheetModal) | 672 cap (source) | 672 cap (source) | 672 cap (source) | 672 centred; ≤82% height | Exception: 80 machine-text columns; internal scrolling |
| `components/buzz/UiSizeSetting.tsx:39` (HullActionSheetModal) | 460 cap (source; overrides unmeasured) | 460 cap (source; overrides unmeasured) | 460 cap (source; overrides unmeasured) | ≤560 centred; ≤82% height | Sheet; internal scrolling |
| `components/buzz/WorkspaceActionsMenu.tsx:41` (HullActionSheetModal) | 460 cap (source; overrides unmeasured) | 460 cap (source; overrides unmeasured) | 460 cap (source; overrides unmeasured) | ≤560 centred; ≤82% height | Sheet; internal scrolling |
| `components/buzz/WorkspaceSettingsPanel.tsx:72` (HullDialog) | 460 cap (source) | 460 cap (source) | 460 cap (source) | 460 retained | Small dialog; preserve focus and Escape |
| `components/buzz/WorkspaceSettingsPanel.tsx:662` (HullActionSheetModal) | 460 cap (source; overrides unmeasured) | 460 cap (source; overrides unmeasured) | 460 cap (source; overrides unmeasured) | ≤560 centred; ≤82% height | Sheet; internal scrolling |
| `components/buzz/WorkspaceSettingsPanel.tsx:687` (HullActionSheetModal) | 460 cap (source; overrides unmeasured) | 460 cap (source; overrides unmeasured) | 460 cap (source; overrides unmeasured) | ≤560 centred; ≤82% height | Sheet; internal scrolling |
| `modal/ModalProvider.tsx:120` (HullActionSheetModal) | 460 cap (source; overrides unmeasured) | 460 cap (source; overrides unmeasured) | 460 cap (source; overrides unmeasured) | ≤560 centred; ≤82% height | Sheet; internal scrolling |
| `modal/components/BaseModal.tsx:25` (HullModal) | placement-dependent; unmeasured | placement-dependent; unmeasured | placement-dependent; unmeasured | ≤560 sheet / 460 dialog / bounded viewer | Inspect direct placement and contentStyle |
| `modal/components/WebAlertModal.tsx:55` (HullDialog) | 460 cap (source) | 460 cap (source) | 460 cap (source) | 460 retained | Small dialog; preserve focus and Escape |
| `modal/components/WebPromptModal.tsx:36` (HullDialog) | 460 cap (source) | 460 cap (source) | 460 cap (source) | 460 retained | Small dialog; preserve focus and Escape |

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
- Run sheet placement regressions, the mobile suite and server shard before a push. Page-local implementation and proof updates are recorded below.

## Page-local implementation and measured sheet reproduction

Reproduction DESKTOP-SHEET-1: open a long shared action sheet without a footer on desktop. The baseline component at `6c2a6c1be` produces a centred 460 px surface whose body is not constrained or scrollable and extends beyond the viewport. The changed real component produces a centred 560 px surface with its body scrolling inside the window. Browser proof uses React Native Web and the real sheet / dialog primitives; device, theme-runtime and animation dependencies use the repository browser harness. The rows are fixture members. This is a local built-component stand-in, not a signed-in production measurement.

| Browser viewport | Before width / height | After width / height | Body scrolling after |
| --- | --- | --- | --- |
| 500 × 761 | 500 / 2147 | 500 / 2147 | False |
| 1280 × 761 | 460 / 2129 | 560 / 605 | True |
| 1440 × 761 | 460 / 2129 | 560 / 605 | True |
| 1920 × 761 | 460 / 2129 | 560 / 605 | True |

The 500 px viewport is the phone layout class; headless Chrome clamps ordinary windows below that width. Its before/after geometry is unchanged, including the existing long-body behaviour. Screenshots and exact measurements are under `sheets/`. Permanent regression coverage runs only the changed component and does not require historical git objects. The one-time baseline capture bundled the original sheet from the recorded commit.

Machine output intentionally retains its existing wider content cap (`ToolOutputSheet`), because code lines need room; the window height remains bounded. Existing confirm and prompt dialogs retain their 460 px cap. Tray keeps its list/detail split with a 720 px maximum for the list and flexible space for the detail pane, rather than constraining both panes to one list column. Channels keeps the desktop Room workbench; its chat/list proportions belong to PR #2915.

Page-local detail caps are implemented for human profiles, workflow definitions, schedules, subscriptions, connector details and wallet forms, onboarding and GitHub return status. Community, create-workspace and join columns expand to 640 px only on desktop. Schedule/workflow lists and workflow-run ledgers cap at 720 px. Members, agent profiles and settings/identity remain owned by PR #2915. Temporary local numeric caps will be replaced with its shared widths after the commanded rebase.

Outstanding: measurements for every production route at 1440/1920 (and original brief's 1280), full page screenshot set, second distinct sheet and confirm screenshots, reviewer-bypass authentication, and integration with PR #2915. Squire opened members and the play-review profile using the existing owner session. A subsequent DOM-title probe could read the viewport, but the browser stayed at 1279 px even when launch viewport settings and popup window dimensions requested 1440 px. No controlled 1440/1920 production viewport was established. The probe popup and session were closed. Local browser-use CLI and local CDP endpoint were absent; the generic browser connector returned an unrelated signup goal. The vault metadata lookup for the reviewer-bypass credential returned an owner-approval/resource-unavailable denial. No successful reviewer-bypass authentication is claimed.

## Built page measurements

The real Schedules list, Schedule detail and Subscription detail were rendered with the repository browser harness, actual bundled fonts, and synthetic service responses. The list is 720 px and the two detail pages are 640 px at desktop widths 1280, 1440 and 1920; all are horizontally centred. At phone-class width 500, each remains 500 px. Screenshots and bounding-box JSON are under `pages/`. These are local after measurements, not production before measurements or proof of an unchanged phone page compared with baseline.
