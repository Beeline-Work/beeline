# Profile audit revision

These captures show the Captain's follow-up on the unified profile system. They come from this branch's running Expo web client and fresh disposable local workspaces; no production workspace or static mock was used. Phone captures are 390×844 and desktop captures are 1440×1000.

## Findings and fixes

1. **Profile actions still read as full-width rows.** Agent and human Message/Edit actions now share one compact, centered, 44-point action group directly under the identity. Edit mode keeps the same group for Message/Cancel/Save.
2. **Soul actions had a broken vertical rhythm.** Read full soul and Generate avatar now live in one zero-gap action stack with a shared inset, so the generator follows the disclosure without an extra section gap.
3. **Human management was visible outside editing.** Edit now explicitly enters management mode. Only then are the Member/Admin selector and Ban action rendered; lower-level viewers see neither Edit nor Ban.
4. **The human profile omitted the member's grants.** A new read-only Settings-row ledger lists settled grants for the member's connected agents. Repository grants remain Workspace-visible; personal-resource grants remain visible only to the agent owner.
5. **Role and ban behavior needed live proof.** In the disposable admin workspace, promoting the member to Admin persisted through the real phone operation and updated the profile. Confirming Ban removed the member and returned to the Workspace. The ordinary-member proof has Message only.

## Before and after

| Finding                              | Before                           | Phone after                                    | Desktop after                                   |
| ------------------------------------ | -------------------------------- | ---------------------------------------------- | ----------------------------------------------- |
| Compact owner actions and soul stack | [agent](agent-mobile-before.png) | [agent owner](agent-owner-mobile-after.png)    | [agent owner](agent-owner-desktop-after.png)    |
| Human compact actions and grants     | [human](human-mobile-before.png) | [admin viewer](human-admin-mobile-after.png)   | [admin viewer](human-admin-desktop-after.png)   |
| Edit-only role and ban controls      | [human](human-mobile-before.png) | [edit mode](human-edit-mobile-after.png)       | [edit mode](human-edit-desktop-after.png)       |
| Ordinary-member restriction          | [human](human-mobile-before.png) | [member viewer](human-member-mobile-after.png) | [member viewer](human-member-desktop-after.png) |

The phone soul stack is also isolated in [agent-soul-mobile-after.png](agent-soul-mobile-after.png).

## Validation

- API contract readers: 138 tests
- Mobile profile/roster management: 54 tests
- Server member-grant privacy integration: focused migrated-database test
- Mobile, server, and API contract TypeScript checks
- Real-browser role promotion and ban against the disposable local backend
- Every after frame visually inspected after capture
