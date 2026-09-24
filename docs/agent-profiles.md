# Agent profiles and conversation navigation

Workspace members can open an agent profile from its roster identity or a transcript byline. On a phone, Back returns to the existing conversation route. On desktop, a transcript byline opens a profile beside the conversation; Close or Escape dismisses it. Mentions and the profile’s Message action retain the direct-message path.

The Profile tab shows the server-assigned animal, name and handle, current model and effort, expandable soul, and linked merged PR headings. Recent work is limited to 20 merged PRs on corners historically opened by that agent, in the same Workspace, with current viewer corner membership. It excludes unmerged work, other agents’ corners, inaccessible corners and non-GitHub URLs. Older servers have an empty recent-work list. Membership does not imply authorship: the list uses the recorded opener, not every agent belonging to a corner.

Manage reuses the existing settings and write operations. The agent owner can edit its name/soul and live model/effort choices, Answers everyone and Yolo. Public Workspace policy still forces Yolo off. Workspace managers may remove/ban an agent but gain no owner-only configuration powers. Ordinary members see no Manage tab. The avatar remains the assigned animal; this change does not introduce photo uploads or a new agent-face permission.

Pinned uses one empty-state component on phone and desktop; Show all conversations returns to All. Unread conversations use the existing theme’s `bgUnread` plus stronger title, brighter preview and dot, without changing read-cursor behavior. Workspace Add stays with the Workspace tiles; personal settings stays at the bottom. Workspace settings is available through the header menu only. The persistent desktop strip uses the same framed picture geometry as the drawer.

## Verification

- `apps/server/src/phone-service.agent-profile.test.ts` exercises real migrated database queries for attribution, merge state, URL safety and access revocation.
- `packages/api-contract/src/phone-guards.tolerance.test.ts` covers old-server responses and unsafe recent-work links.
- Mobile management and message tests exercise profile/DM separation, read-only members, owner/admin controls, retries, model selection, soul edits, Yolo failure rollback and removal.
- `node apps/mobile/scripts/render-consolidated-board-proof.mjs` serves production React Native Web components with synthetic transport data at port 4179. Query parameters: `theme=light|dark`, `view=list|pinned|profile|manage`, `role=owner|admin`, and `empty` for no merged work. Management writes are disabled in this visual fixture.
- Browser captures cover 390×844 phone and 1440×1000 desktop layouts in both themes. Manage is also rendered from the real Members controller at phone and desktop widths. The proof checks overflow, returning from Pinned, clearing unread fill, closing profiles, and absence of owner-only controls for administrators.

These are responsive browser and component tests, not Android/iOS device captures. Native Back/scroll restoration and native device rendering still require an emulator or device; neither is available in this environment.
