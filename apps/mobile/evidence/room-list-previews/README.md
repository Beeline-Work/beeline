# Room-list preview proof

The component proof came from Emberus's `feature/emberus-room-list-v12` worktree.
These images were regenerated after comparison with the supplied phone and
desktop HTML mocks in `../room-list-reference/`; they render the current
shared Room-list components with fixture conversations, using
`node apps/mobile/scripts/render-room-list-proof.mjs` from the repository root.
They cover Obsidian and Bone at 390px and 1440px, plus a 280px desktop sidebar.
The wide desktop proofs include the persistent 76px Workspace rail and the
380px default Room list; the narrow desktop proof retains the switcher layout.
The desktop proof uses an illustrative transcript area; it verifies the list
layout rather than navigation or live data behavior.

The `phone-*` and `desktop-*` pin captures show the long-press menu, a pinned
Room, and the empty Pinned view using the shared components. The authenticated
versions are in `../room-list-live-web/`.
