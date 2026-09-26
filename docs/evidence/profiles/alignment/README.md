# Profile design-language audit

This pass audited the agent profile, human profile, Settings, and the Members entry point as one system against `DESIGN.md`. The captures below come from this branch's running Expo web client at 390×844, backed by fresh local servers and disposable proof accounts. The owner/admin and ordinary-member states were captured in separate disposable workspaces; no production workspace or static screen mock was used.

## Findings and fixes

1. **Headers had three competing treatments.** Agent profile used a small `‹ Profile`, human profile used boxed Back/Edit buttons, while Settings and Members each had local header markup. All four now render the shared `PageHeader` with the same plain chevron, hero title, divider, height, and spacing. The new prominent option is scoped to these profile-shaped surfaces so existing tool-page headers keep their established scale.
2. **Identity geometry was duplicated.** Settings carried a private copy of the profile bezel, portrait seat, handle, and role styles. `ProfileIdentity` now owns that identity block for agent profile, human profile, and Settings while retaining Settings' face picker and GitHub-handle link behavior.
3. **Primary actions looked like unrelated controls.** Agent Message/Edit and human Back/Edit were boxed buttons, avatar generation was a full-width boxed button, and management actions used rows. Message, Edit, Save, Cancel, Generate avatar, and Ban now use the existing borderless `SettingsRow` action vocabulary. Destructive tone remains reserved for Ban.
4. **Avatar generation exposed an unrequested direction field.** The free-text direction input is removed. Generate sends the current soul only; the existing client/server single-flight guard still disables the row while active, and the exact status `generating, will DM you when the avatar is ready` appears underneath. Confirmation and error retry behavior remain intact.
5. **Section hierarchy and spacing drifted between profiles.** SOUL and Recent work used page-specific strong labels and action spacing. Both now use the shared section-head typography and the repository spacing scale, matching the Settings list cadence.
6. **The entry paths needed a system-level verification.** Members' human and agent rows already route to the associated profiles, transcript bylines already route to profiles, and a viewer's own byline already routes to Settings. Those behaviors remain unchanged and are covered by the existing navigation tests; Members now shares the same header component as the destinations.
7. **Permission-specific presentation needed proof.** Owner-only agent Edit/Generate controls, higher-rank human Edit/Ban controls, read-only agent state, and ordinary-member human state are unchanged. Separate role-backed captures below verify both sides of each permission boundary.

## Before and after

The supplied current-main agent and human captures are the visual baselines for both permission variants; the permission differences are shown in the branch captures.

| Surface                                   | Before                              | After                                  |
| ----------------------------------------- | ----------------------------------- | -------------------------------------- |
| Agent profile — owner                     | [current main](../agent-dark.png)   | [owner](agent-owner-after.png)         |
| Agent profile — non-owner                 | [current main](../agent-dark.png)   | [non-owner](agent-non-owner-after.png) |
| Human profile — admin/higher-level viewer | [current main](../human-light.png)  | [admin](human-admin-after.png)         |
| Human profile — ordinary member           | [current main](../human-light.png)  | [member](human-member-after.png)       |
| Settings                                  | [current main](settings-before.png) | [aligned](settings-after.png)          |

The generation transition is also captured in [agent-owner-generating-after.png](agent-owner-generating-after.png): the row is disabled and the promised DM status sits directly below it.

## Validation

- Mobile TypeScript check: `npm run typecheck --prefix apps/mobile`
- Focused profile, Settings, Members, and header suite: 84 tests
- Browser inspection: five required after states plus the Settings before state, each at exactly 390×844
- Browser console: no profile-page runtime errors; Settings retains a pre-existing React Native Web development-only accessibility warning present in its before state
