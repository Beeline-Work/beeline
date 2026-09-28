# Ink button review frames

These are 390 × 844 frames captured from the running Expo web app with
`chrome-devtools-axi`. Before frames used the merged `#1865` source; after
frames used this branch. The local design-audit fixture supplied an owner
Workspace, Room with an `@niglet` mention, connected Workbench tools, and
sample app states. No production account or Workspace data was used. The
`__button-proof` route used to render dormant component states was temporary
and is not part of this change.

| Surface | Before | After |
| --- | --- | --- |
| Sign-in, light | [frame](before/sign-in-light.png) | [frame](after/sign-in-light.png) |
| Sign-in, dark | [frame](before/sign-in-dark.png) | [frame](after/sign-in-dark.png) |
| You onboarding | [frame](before/you-light.png) | [frame](after/you-light.png) |
| Create Workspace | [frame](before/create-workspace-light.png) | [frame](after/create-workspace-light.png) |
| Workbench with fixture tools and apps | [frame](before/workbench-apps-light.png) | [frame](after/workbench-apps-light.png) |
| Workbench Connect sign-in and retry | [frame](before/workbench-connect-light.png) | [frame](after/workbench-connect-light.png) |
| Shared Hull dialog | [frame](before/hull-dialog-light.png) | [frame](after/hull-dialog-light.png) |
| Leave Room dialog | [frame](before/leave-dialog-light.png) | [frame](after/leave-dialog-light.png) |
| New Room dialog | [frame](before/new-room-dialog-light.png) | [frame](after/new-room-dialog-light.png) |
| Human profile role selection | [frame](before/human-profile-role-light.png) | [frame](after/human-profile-role-light.png) |
| Corner app action | [frame](before/corner-action-light.png) | [frame](after/corner-action-light.png) |
| Settings compact action | [frame](before/settings-action-control-light.png) | [frame](after/settings-action-control-light.png) |
| Channels and shared compose control | [frame](before/channels-light.png) | [frame](after/channels-light.png) |
| Non-header compose control | [frame](before/compose-control-light.png) | [frame](after/compose-control-light.png) |
| Pinned empty action | [frame](before/pinned-empty-light.png) | [frame](after/pinned-empty-light.png) |
| Search empty action | [frame](before/no-matches-light.png) | [frame](after/no-matches-light.png) |
| Workspace Settings | [frame](before/workspace-settings-light.png) | [frame](after/workspace-settings-light.png) |
| Settings with brass profile `@` | [frame](before/settings-links-light.png) | [frame](after/settings-links-light.png) |
| Room with brass `@niglet` mention | [frame](before/room-mention-light.png) | [frame](after/room-mention-light.png) |

The unchanged brass `@` and mention are visible in the last two pairs.
`button-color.guard.test.ts` also pins the mention, profile `@`, and link
token to `accent`. The screenshot pass verifies the web renderer; physical
phone appearance and release remain separate gates.
