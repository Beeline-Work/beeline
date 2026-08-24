# Mobile route design inventory

Captured on 2026-08-24 from the Android emulator (`emulator-5554`, 1080×2400) against the production Beeline app before this branch changed mobile source. `DESIGN.md` is the classifier authority: one aubergine slab, content-bright/chrome-dim hierarchy, semantic prose plus IBM Plex Mono labels, 3px box radii, hairline index rules, and the product glyph vocabulary.

`CANONICAL` means the rendered destination follows that language. Compatibility routes that only redirect are classified by their rendered destination. `DRIFTED` means the route still exposes the legacy glass/card system or an unregistered duplicate route leaks that system around otherwise-canonical content.

| Expo route file | Rendered route/state | Classification | Screenshot | Evidence |
|---|---|---:|---|---|
| `(app)/index.tsx` | `/` → Room list | CANONICAL | [before](root-index-before.png) | Compatibility landing resolves to the canonical Room index; the captured keyboard is retained emulator state, not route chrome. |
| `(app)/buzz/channels.tsx` | `/buzz/channels` | CANONICAL | [before](buzz-channels-before.png) | Flat aubergine slab, mono chrome, hairline rows, content-bright names. |
| `(app)/buzz/chat/[channelId].tsx` | `/buzz/chat/:channelId` | CANONICAL | [before](buzz-chat-before.png) | Shared ledger language, slab header, mono state line, no message cards. |
| `(app)/buzz/corners/[roomId].tsx` | `/buzz/corners/:roomId` | CANONICAL | [before](buzz-corner-before.png) | Shared ledger, mono objective/status vocabulary, flat composer. |
| `(app)/buzz/members.tsx` | `/buzz/members` | CANONICAL | [before](buzz-members-before.png) | Custom slab header, identity marks, flat rows, mono role/presence labels. |
| `(app)/buzz/agents.tsx` | `/buzz/agents` → Members | CANONICAL | [before](buzz-agents-before.png) | Compatibility redirect lands on canonical Members. |
| `(app)/buzz/MembersScreen.tsx` | `/buzz/MembersScreen` | **DRIFTED** | [before](buzz-members-screen-before.png) | Legacy pill/glass Stack header sits above the screen's own slab header; duplicate back affordances compress content; default route treatment can leave the keyboard covering half the roster. |
| `(app)/buzz/community.tsx` | `/buzz/community` | CANONICAL | [before](buzz-community-before.png) | Hairline tab, 3px input/action boxes, semantic type and slab canvas. |
| `(app)/buzz/onboarding.tsx` | `/buzz/onboarding` | CANONICAL | [before](buzz-onboarding-before.png) | Brand lockup is the only display face; actions use 3px boxes, Space Grotesk theme prose, mono support copy, and one flat canvas. |
| `(app)/buzz/github-callback.tsx` | `/buzz/github-callback` → onboarding | CANONICAL | [before](buzz-github-callback-before.png) | Redirect renders canonical onboarding. |
| `(app)/buzz/github-installation.tsx` | `/buzz/github-installation` → prior surface/Rooms | CANONICAL | [before](buzz-github-installation-before.png) | Redirect renders canonical Room index when no pending installation return exists. |
| `(app)/buzz/settings/index.tsx` | `/buzz/settings` | CANONICAL | [before](buzz-settings-before.png) | Settings is a flat index: mono section labels, one hairline per row, no cards. |
| `(app)/buzz/settings/identity.tsx` | `/buzz/settings/identity` | CANONICAL | [before](buzz-settings-identity-before.png) | Semantic prose/mono type, 3px form controls, hairline sections, aubergine slab. |
| `(app)/buzz/settings/workspace.tsx` | `/buzz/settings/workspace?communityId=…` | CANONICAL | [before](buzz-settings-workspace-before.png) | Identity mark, flat sections, mono labels, 3px inputs/buttons; no legacy cards. |
| `(app)/buzz/community.tsx` (create Room state) | Room-list `＋ ROOM` state | CANONICAL | [before](add-room-before.png) | Inline creation stays on the slab with one hairline section and 3px actionable boxes. |
| `(app)/settings/index.tsx` | `/settings` → Buzz settings | CANONICAL | [before](settings-index-before.png) | Compatibility redirect lands on canonical settings index. |
| `(app)/settings/appearance.tsx` | `/settings/appearance` | **DRIFTED** | [before](appearance-before.png) | Oversized glass/pill header and circular back button; repeated ~18px grouped cards; multicolor Ionicons, switches, and bubble preview contradict the mono glyph/palette vocabulary. |
| `(app)/settings/agents.tsx` | `/settings/agents` | **DRIFTED** | [before](settings-agents-before.png) | Glass/pill navigation; card-per-provider grouping with large radii; violet/orange generic icons and non-semantic row styling. |
| `(app)/settings/features.tsx` | `/settings/features` | **DRIFTED** | [before](features-before.png) | Glass/pill navigation; rounded card groups; rainbow Ionicons and generic switches overpower content hierarchy. |
| `(app)/settings/language.tsx` | `/settings/language` | **DRIFTED** | [before](settings-language-before.png) | Glass/pill navigation; one large rounded card around the full list; repeated bright-blue language icons/check instead of mono labels and hairline rows. |
| `(app)/changelog.tsx` | `/changelog` | **DRIFTED** | [before](changelog-before.png) | Legacy glass header; generic document typography with no mono metadata seam; first heading crowds the header instead of beginning below a slab hairline. |
| `(app)/text-selection.tsx` | `/text-selection` (missing-id state) | **DRIFTED** | [before](text-selection-before.png) | Glass/pill header and copy icon; 22px glass content surface; missing-id path opens a bright native Alert that abandons the app palette/type/radius vocabulary. |
| `(app)/join/[token].tsx` | `/join/:token` (malformed-token state) | CANONICAL | [before](join-token-before.png) | Buzz-token canvas, semantic typography, hairline header, direct recovery action. |
| `(app)/new/index.tsx` | `/new` → Rooms | CANONICAL | [before](new-before.png) | Compatibility redirect lands on canonical Room index/current Room. |
| `(app)/session/[...legacy].tsx` | `/session/*` → Rooms | CANONICAL | [before](session-legacy-before.png) | Compatibility redirect lands on canonical Room index. |

## Inventory result

- 24 route files/states rendered.
- 7 drifted surfaces: the accidental uppercase Members route, four legacy settings leaves, changelog, and text selection.
- The owner-named Buzz settings hub, identity/workspace settings, Members destination, add-Room state, and onboarding entry are already canonical on current `main`; they remain in the evidence set so parity is verified rather than assumed.
- Redirect-only routes preserve navigation behavior and need no visual implementation of their own.
