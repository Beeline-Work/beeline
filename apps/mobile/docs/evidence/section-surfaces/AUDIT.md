# Section surface audit

The app uses the same React Native components on phone and web/desktop. Audited all shared section-header call sites, all SectionList headers, standalone header styles, screen-token background declarations, and static web pages. No palette, layout or copy changes.

## Findings

| Location | Result |
| --- | --- |
| `apps/mobile/sources/components/buzz/RoomListSectionHeader.tsx:150` | Fixed: removed the unconditional screen fill; transparent default with explicit opaque screen opt-in. |
| `apps/mobile/sources/app/(app)/beeline/channels.tsx:1005` | Audited: screen/pane owns matching bgBase/bgTerminal; default inheritance preserves appearance. |
| `apps/mobile/sources/app/(app)/beeline/human-profile.tsx:321` | Audited: screen/pane owns matching bgBase/bgTerminal; default inheritance preserves appearance. |
| `apps/mobile/sources/app/(app)/beeline/human-profile.tsx:362` | Audited: screen/pane owns matching bgBase/bgTerminal; default inheritance preserves appearance. |
| `apps/mobile/sources/app/(app)/beeline/human-profile.tsx:407` | Audited: screen/pane owns matching bgBase/bgTerminal; default inheritance preserves appearance. |
| `apps/mobile/sources/app/(app)/beeline/members.tsx:1430` | Audited: screen/pane owns matching bgBase/bgTerminal; default inheritance preserves appearance. |
| `apps/mobile/sources/app/(app)/beeline/members.tsx:1460` | Audited: screen/pane owns matching bgBase/bgTerminal; default inheritance preserves appearance. |
| `apps/mobile/sources/app/(app)/beeline/onboarding.tsx:557` | Audited: screen/pane owns matching bgBase/bgTerminal; default inheritance preserves appearance. |
| `apps/mobile/sources/app/(app)/beeline/settings/identity.tsx:532` | Audited: screen/pane owns matching bgBase/bgTerminal; default inheritance preserves appearance. |
| `apps/mobile/sources/app/(app)/beeline/settings/identity.tsx:553` | Audited: screen/pane owns matching bgBase/bgTerminal; default inheritance preserves appearance. |
| `apps/mobile/sources/app/(app)/beeline/settings/identity.tsx:595` | Audited: screen/pane owns matching bgBase/bgTerminal; default inheritance preserves appearance. |
| `apps/mobile/sources/app/(app)/beeline/settings/workbench/app.tsx:102` | Audited: screen/pane owns matching bgBase/bgTerminal; default inheritance preserves appearance. |
| `apps/mobile/sources/app/(app)/beeline/settings/workbench/connect-app.tsx:45` | Fixed generically: inherits appCanvas on pages and bgRaised inside Search sheet. |
| `apps/mobile/sources/app/(app)/beeline/settings/workbench/connect.tsx:248` | Audited: screen/pane owns matching bgBase/bgTerminal; default inheritance preserves appearance. |
| `apps/mobile/sources/app/(app)/beeline/settings/workbench/connection.tsx:169` | Audited: screen/pane owns matching bgBase/bgTerminal; default inheritance preserves appearance. |
| `apps/mobile/sources/app/(app)/beeline/settings/workbench/connection.tsx:203` | Audited: screen/pane owns matching bgBase/bgTerminal; default inheritance preserves appearance. |
| `apps/mobile/sources/app/(app)/beeline/settings/workbench/connection.tsx:227` | Audited: screen/pane owns matching bgBase/bgTerminal; default inheritance preserves appearance. |
| `apps/mobile/sources/app/(app)/beeline/settings/workbench/connection.tsx:264` | Audited: screen/pane owns matching bgBase/bgTerminal; default inheritance preserves appearance. |
| `apps/mobile/sources/app/(app)/beeline/settings/workbench/service.tsx:128` | Fixed generically: inherits appCanvas on pages and bgRaised inside Search sheet. |
| `apps/mobile/sources/app/(app)/beeline/settings/workbench/service.tsx:142` | Fixed generically: inherits appCanvas on pages and bgRaised inside Search sheet. |
| `apps/mobile/sources/app/(app)/beeline/settings/workbench/service.tsx:160` | Fixed generically: inherits appCanvas on pages and bgRaised inside Search sheet. |
| `apps/mobile/sources/app/(app)/beeline/settings/workbench/wallet.tsx:215` | Audited: screen/pane owns matching bgBase/bgTerminal; default inheritance preserves appearance. |
| `apps/mobile/sources/app/(app)/beeline/settings/workbench/wallet.tsx:277` | Audited: screen/pane owns matching bgBase/bgTerminal; default inheritance preserves appearance. |
| `apps/mobile/sources/app/(app)/beeline/settings/workbench/wallet.tsx:325` | Audited: screen/pane owns matching bgBase/bgTerminal; default inheritance preserves appearance. |
| `apps/mobile/sources/app/(app)/beeline/settings/workbench/wallet.tsx:381` | Audited: screen/pane owns matching bgBase/bgTerminal; default inheritance preserves appearance. |
| `apps/mobile/sources/app/(app)/beeline/settings/workbench.tsx:47` | Fixed generically: inherits appCanvas on pages and bgRaised inside Search sheet. |
| `apps/mobile/sources/app/(app)/beeline/settings/workbench.tsx:54` | Fixed generically: inherits appCanvas on pages and bgRaised inside Search sheet. |
| `apps/mobile/sources/app/(app)/beeline/workflow-run.tsx:153` | Audited: screen/pane owns matching bgBase/bgTerminal; default inheritance preserves appearance. |
| `apps/mobile/sources/app/(app)/beeline/workflow-run.tsx:187` | Audited: screen/pane owns matching bgBase/bgTerminal; default inheritance preserves appearance. |
| `apps/mobile/sources/app/(app)/beeline/workflow.tsx:85` | Audited: screen/pane owns matching bgBase/bgTerminal; default inheritance preserves appearance. |
| `apps/mobile/sources/components/SidebarView.tsx:594` | Audited: screen/pane owns matching bgBase/bgTerminal; default inheritance preserves appearance. |
| `apps/mobile/sources/components/buzz/AgentProfileView.tsx:192` | Audited: screen/pane owns matching bgBase/bgTerminal; default inheritance preserves appearance. |
| `apps/mobile/sources/components/buzz/AgentProfileView.tsx:264` | Audited: screen/pane owns matching bgBase/bgTerminal; default inheritance preserves appearance. |
| `apps/mobile/sources/components/buzz/AgentProfileView.tsx:284` | Audited: screen/pane owns matching bgBase/bgTerminal; default inheritance preserves appearance. |
| `apps/mobile/sources/components/buzz/AgentProfileView.tsx:298` | Audited: screen/pane owns matching bgBase/bgTerminal; default inheritance preserves appearance. |
| `apps/mobile/sources/components/buzz/AgentUsageSection.tsx:175` | Audited: screen/pane owns matching bgBase/bgTerminal; default inheritance preserves appearance. |
| `apps/mobile/sources/components/buzz/AgentVoiceSection.tsx:134` | Audited: screen/pane owns matching bgBase/bgTerminal; default inheritance preserves appearance. |
| `apps/mobile/sources/components/buzz/CornerAppScreen.tsx:103` | Audited: screen/pane owns matching bgBase/bgTerminal; default inheritance preserves appearance. |
| `apps/mobile/sources/components/buzz/DirectMessagePickerSheet.tsx:70` | Already correct: explicit sheet surface is transparent; preserved. |
| `apps/mobile/sources/components/buzz/DirectMessagePickerSheet.tsx:87` | Already correct: explicit sheet surface is transparent; preserved. |
| `apps/mobile/sources/components/buzz/ForwardMessagePickerSheet.tsx:97` | Already correct: explicit sheet surface is transparent; preserved. |
| `apps/mobile/sources/components/buzz/RepoList.tsx:84` | Already correct: explicit sheet surface is transparent; preserved. |
| `apps/mobile/sources/components/buzz/RepoPicker.tsx:223` | Fixed: header inherits bgHighlight; sticky row now paints bgHighlight behind label and count. |
| `apps/mobile/sources/components/buzz/RoomRosterSheet.tsx:153` | Already correct: explicit sheet surface is transparent; preserved. |
| `apps/mobile/sources/components/buzz/ScheduledWorkDetail.tsx:19` | Audited: screen/pane owns matching bgBase/bgTerminal; default inheritance preserves appearance. |
| `apps/mobile/sources/components/buzz/WorkspaceSettingsPanel.tsx:482` | Audited: screen/pane owns matching bgBase/bgTerminal; default inheritance preserves appearance. |
| `apps/mobile/sources/components/buzz/WorkspaceSettingsPanel.tsx:580` | Audited: screen/pane owns matching bgBase/bgTerminal; default inheritance preserves appearance. |
| `apps/mobile/sources/components/buzz/WorkspaceSettingsPanel.tsx:598` | Audited: screen/pane owns matching bgBase/bgTerminal; default inheritance preserves appearance. |

## Other candidates

- `PageHeader.tsx:92`, `SettingsScopeTabs.tsx:87`, `DesktopRoomInspector.tsx:713`, `DesktopArtifactPane.tsx:237`, `ArtifactViewer.tsx:342`, `CornerAppScreen.tsx:154`, `PrLifecycleCard.tsx:259`, `tray.tsx:871`: header/title styles already have no fill. No fix needed.
- `channels.tsx:992` and `RepoList.tsx:91`: sticky section headers explicitly disabled; transparent labels are safe. Sidebar sections are ordinary mapped children.
- `RepoPicker.tsx:217`: the remaining SectionList header can stick on iOS; its entire row must stay opaque. Its only production caller is `_chat-surface.tsx:6706`, inside `repoPromptBanner` (`bgHighlight`, line 7733). Fixed the full sticky row, including its trailing count.
- `WorkspaceSettingsPanel.tsx:773`, `AgentProfileView.tsx:350`, human profiles, workflows, onboarding, member lists and wallet sections own matching screen surfaces. No existing mismatch found.
- `IndexRow.tsx:481`: ordinary settings/sheet rows have no normal-state fill; press/selection fills are intentional. No fix needed.
- `HullDialog.tsx:533`: screen-colored scrim belongs to the backdrop, not a label; `floatingSurface` uses `bgRaised` at line 545. No fix needed.
- Transcript action popovers, scrubber bubbles, mention and slash menus, CommunityRail plates, and reaction chips own their backgrounds rather than painting section labels over another surface. No matching defect found.
- Static `web/` marketing/legal/invite/review pages: checked header/label/group background rules; no shared app label inside a differently colored sheet or panel. No fix needed.
