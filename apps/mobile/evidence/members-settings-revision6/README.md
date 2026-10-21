# Revision 6: primary-row Members and Tray

Design review only. Merge hold stays; no merge or release. Not a defect report.

## Changed behavior

Mobile and desktop now put Members then Tray beside the Workspace switcher in the primary row. The second row contains only filters and search. The existing TrayGlyph now uses the existing quiet Button when an onPress callback is supplied; the same badge markup, compact count, selected fill and navigation remain intact. No new component was created. The registry additionally names the local JSX value `glyph` because the scanner indexes JSX variables as component symbols.

Both primary-row glyphs are 22 px, inside identical 56×44 px quiet Buttons with 17 px horizontal glyph padding. Tray occupies the former rightmost Members position: button right inset 16 px on mobile and desktop. Members sits immediately to its left (desktop retains its existing 4 px action gap). Android screenshot coordinates are true mdpi pixels; desktop is device scale 1.

## Shared section headers

All four still use `apps/mobile/sources/components/buzz/RoomListSectionHeader.tsx`. The implementation is identical to production v0.1.94 (`703bbdbf`); no duplicate header implementation remains. Members has no visible header change: its content container supplies the same screen inset and it retains existing flush vertical spacing.

| Section | Android action inset | Desktop action inset |
| --- | ---: | ---: |
| ROOMS | 16 px | 16 px |
| DIRECT MESSAGES | 16 px | 16 px |
| PEOPLE | 16 px | 16 px |
| AGENTS | 16 px | 16 px |

All eight glyph-box insets are 30 px; action-center insets are 38 px. Native crops are extracted without resizing from 412×915 at density 160. Desktop crops are extracted without resizing from 1279×936. measurements.json records the coordinates. The production-source ROOMS baseline from revision 4 was compared again with the newly rendered revision 6 crop: **zero differing pixels**.

## Complete capture set

- 01/02 desktop and 05/07 Android: full Room lists without/with the real Tray badge. Members is left of Tray in the primary row; second row has no Tray.
- 03 desktop and 08 Android: Members with PEOPLE and AGENTS and their shared + controls.
- crop-*: true 1:1 right-edge crops of each of the four headers, mobile and desktop.
- 04 desktop and 06 Android: tapping the relocated Tray opens the actual Tray. The seeded question appears in Needs you. Android Clear removes it and immediately removes the badge on return to Rooms.
- 09 desktop and 10 Android: switcher without separate Join. No extra “Join with invite” card remains in this PR; Add retains production's existing “Join with an invite link” choice unchanged.
- 11 Android and 12 desktop: owner Settings has one Workspace row, with Beeline as its value, between Connectors and Device. Admin gating remains covered by tests.
- 13/14 Android: that row opens the existing Workspace screen with Back to Settings and Room controls; Copy public join link shows no URL; tapping shows the existing Join link copied confirmation.
- 15 desktop: the same Workspace screen reached through Settings.
- 16 desktop: actual server member role; Settings has no Workspace row. The unchanged Android member Settings capture from revision 4 is also included in the combined gallery.

All new captures use the full app and an isolated authenticated in-memory server, never production accounts/data. server.mts adds only a local /_proof/badge/on toggle that edits a seeded question; the app reads and clears it through ordinary server operations. Native development-menu onboarding was dismissed and its floating Tools button disabled for unobscured navigation. Android warm startup hit a native SIGSEGV during proof; clearing this private emulator app's data restored the clean session used for the captures. Non-admin proof uses the current desktop and the previously captured Android member screen.

Validation: root typecheck, UI component policy, 138 focused tests (64 navigation/live/Tray/palette; 28 design/calm/header/badge; 46 Settings/clipboard/Room controls). Impeccable scan has no findings. Fresh independent review and CI apply to the pushed head.
