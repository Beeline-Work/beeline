# Revision 4 owner review

Design prototype; no merge or release. This is not a defect report.

The complete signed-in Android app and desktop Expo web app use the isolated, authenticated in-memory server from ../members-settings-prototype/server.mts. Android API 36 uses a private leased emulator. No production accounts or data were used.

## Measured headers

Both ROOMS and DIRECT MESSAGES use the unchanged production RoomListSectionHeader. Diffing that component and the desktop header rendering against v0.1.94 (703bbdbf) found no margin, padding or position changes to revert. Fresh production-source SidebarView and current SidebarView renders confirm the ROOMS right-edge crop is pixel-identical (zero differing pixels). The full baseline is 00-desktop-production-source.png; the final desktop is 02-desktop-rooms.png.

Desktop: pane right x=339, action right x=323; offset **16 px**. Android at mdpi: screen right x=412, action right x=396; offset **16 px**. Both sections have the same bounds. Glyph box right offset is **30 px** and action center right offset **38 px** on both. Android was captured at native 412×915, density 160, so its mdpi crops and desktop crops are true 1:1 physical pixels, with no resampling. The original 1080×2400 capture has a 42 physical px action inset (=16 dp at density 420). Measurements and Android UI bounds accompany the images.

## Demonstrated

- 01-android-rooms.png and 11-android-rooms-mdpi.png: mobile ROOMS and DIRECT MESSAGES creation actions, Members glyph, unchanged filters and Tray. 02-desktop-rooms.png shows the corresponding desktop.
- crop-*-1to1.png: header right edges; production/current desktop crops are exactly equal. The mdpi Android crops match the desktop geometric offsets; native font rasterization differs.
- 03-android-switcher.png and 08-desktop-switcher.png: Add remains; separate Join removed. Add's existing Create/Join screen remains unchanged. No separate Join card remains in either switcher.
- 04-android-admin-settings.png and 09-desktop-admin-settings.png: owner sees one Workspace row with Beeline as its value between Connectors and Device. Existing renderer coverage also exercises admin access.
- 05-android-workspace-copy-before.png and 10-desktop-workspace.png: tapping that row opens the existing Workspace page with Back to Settings and Room management intact. No inline Workspace section remains in Settings.
- 06-android-workspace-copy-after.png: tapping Copy public join link changes the existing row confirmation to Join link copied. URL text is never rendered. Tests verify the clipboard receives the actual permanent link on Android and web.
- 07-android-member-settings.png: the same isolated account with server membership changed to member sees Connectors followed by Device, without Workspace.

The small floating Tools control belongs to the Android development client.

Validation: root typecheck; UI component policy; 85 focused tests including owner/admin/member navigation, clipboard, both workspace switchers, existing Room management, design and calm lints. Impeccable detector: no findings. Merge hold remains.
