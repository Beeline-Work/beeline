# Agent profiles and conversation navigation

Workspace members can open an agent profile from its roster identity or a transcript byline. On a phone, Back returns to the existing conversation route. On desktop, a transcript byline opens a profile beside the conversation; Close or Escape dismisses it. Mentions and the profile’s Message action retain the direct-message path.

The Profile tab shows the server-assigned animal, name and handle, current model and effort, expandable soul, and linked merged PR headings. Recent work is limited to 20 merged PRs on corners historically opened by that agent, in the same Workspace, with current viewer corner membership. It excludes unmerged work, other agents’ corners, inaccessible corners and non-GitHub URLs. Older servers have an empty recent-work list. Membership does not imply authorship: the list uses the recorded opener, not every agent belonging to a corner.

Manage reuses the existing settings and write operations. The agent owner can edit its name/soul and live model/effort choices, Answers everyone and Yolo. Public Workspace policy still forces Yolo off. Workspace managers may remove/ban an agent but gain no owner-only configuration powers. Ordinary members see no Manage tab. The avatar remains the assigned animal; this change does not introduce photo uploads or a new agent-face permission.

The Pinned empty state, unread rows and Workspace rail changes shipped alongside this are specified in [DESIGN.md](../DESIGN.md#index-rows).

## Verification

- `apps/server/src/phone-service.agent-profile.test.ts` exercises real migrated database queries for attribution, merge state, URL safety and access revocation.
- `packages/api-contract/src/phone-guards.tolerance.test.ts` covers old-server responses and unsafe recent-work links.
- Mobile management and message tests exercise profile/DM separation, read-only members, owner/admin controls, retries, model selection, soul edits, Yolo failure rollback and removal.
- `node apps/mobile/scripts/render-consolidated-board-proof.mjs` serves production React Native Web components with synthetic transport data at port 4179. Query parameters: `theme=light|dark`, `view=list|pinned|profile|manage`, `role=owner|admin`, and `empty` for no merged work. Management writes are disabled in this visual fixture.
- Browser captures cover 390×844 phone and 1440×1000 desktop layouts in both themes. Manage is also rendered from the real Members controller at phone and desktop widths. The proof checks overflow, returning from Pinned, clearing unread fill, closing profiles, and absence of owner-only controls for administrators.

These are responsive browser and component tests, not Android/iOS device captures. Native Back/scroll restoration and native device rendering still require an emulator or device; neither is available in this environment.

## Consolidated board acceptance checklist

The approved reference is `complete-room-agent-review.html`; `rooms-desktop-dark-v12.html` is the original rail reference. This is the single acceptance checklist for the implementation in PR #1677. Illustrative names, artwork, model choices, and PR titles belong only to the proof fixture, never production data.

| Item | Implementation and evidence | Remaining acceptance |
| --- | --- | --- |
| 1. Pinned empty state | Shared `PinnedConversationsEmpty`, contained spacing, approved copy, Show all returns to All; phone/desktop captures in both themes. | Independent visual audit against canonical board. |
| 2. Original workspace rail | Framed workspace identities, Add with workspace tiles, personal settings at bottom; Workspace Settings removed from rail, retained in header overflow. | Independent comparison with original rail source and header navigation. |
| 3. Unread emphasis | Theme-specific background tint, stronger title and dot; browser exercise clears unread fill and existing read-cursor behavior is retained. | Independent read/unread and theme audit. |
| 4. Profile vs DM navigation | Agent byline and roster open profiles; mentions/Message keep DMs. Desktop byline profile is adjacent to the transcript; phone uses a pushed route. Component and browser interaction checks pass. | Native Back/scroll restoration and byline long-press remain unverified. |
| 5. Profile contents and work access | Assigned animal, handle, live model/effort, expandable full soul, recent merged PR headings and empty state. Database test excludes inaccessible, unmerged, unsafe-link and other-opener work, including after membership revocation. | Independent data/access audit. |
| 6. Permitted management | Existing name/soul/model/effort/Answers everyone/Yolo/removal controls live in Manage. Owners retain configuration authority; non-owner managers get ban/removal only; members read profiles. Assigned-animal avatar is preserved; no new upload or face-edit permission. Role and mutation tests pass. | Independent check that all pre-existing permitted controls were retained. |
| 7. Cross-surface verification | Phone and desktop browser widths, both themes, readable text, navigation, empty states and owner/admin views captured in `docs/evidence/consolidated-board/`. Component, contract and database checks supplement the fixture. | Native Android/iOS device coverage is outstanding. Remote CI and configured reviewer approval are required before merge. |

A follow-up regression reproduces a failed profile read followed by a successful workspace subscription refresh. The refresh previously removed Retry; separate workspace error state preserves the profile error and the regression confirms retry succeeds. Do not classify that fix as unimplemented based on the earlier interrupted validation report.
