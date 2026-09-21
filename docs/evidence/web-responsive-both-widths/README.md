# Web layout at phone width and desktop width

The page tries to size to the viewport and was reading the wrong size at both
ends. Layout decision and route handling were compared before this change:
they do not share a cause. Boot URLs landing on the Room deck is the Home
`pathname !== '/'` guard from https://github.com/lunchbox-fortwo/buzzy/pull/1532.
This change is the shell's width class.

## Cause

- **Trigger.** `SidebarNavigator` passed `isDesktopPlatform()` (true for every
  browser) into `usesPersistentDesktopFrame` / `showsDesktopSessionChrome` as
  if web were a native Tauri window. The two-pane frame stayed on at 390 CSS
  px. The Room work pane then classified the window from `screen.availWidth`
  (3840 on this machine) instead of the live `window` width.
- **Mask.** `useIsDesktop()` already follows live width and correctly goes
  compact below 768. Inner screens therefore painted the phone Room deck
  *inside* the desktop frame.
- **Symptom.** Rail plus Room list took most of a phone tab; the leftover
  column showed the right edge of that second list (ages, a stranded
  MESSAGES head) and the Workspace mark / person glyph twice. A narrowed
  desktop window still received a wide-window work pane.

The Illegal invocation crash is https://github.com/lunchbox-fortwo/buzzy/pull/1539
and was not reopened.

## Production

`https://web.usebeeline.app` at 390×844 and 1440×900 opens onboarding. That
route is excluded from app-surface chrome (`!pathname.includes('/onboarding')`),
so the signed-out page cannot show the two-pane defect. Viewport itself is
honest there (`innerWidth` 390 / 1440). Signed-in reproduction uses the same
Expo web bundle against `.verification/design-audit/fixture-server.mts`.

## Before (this branch's parent, 390×844)

`before-phone-390x844.png` — `innerWidth` 390, `screen.availWidth` 3840.
Present: `desktop-navigation-pane`, `desktop-room-search`,
`desktop-navigation-resizer`, `workspace-avatar-trigger`,
`profile-settings-navigation`. The right-hand column is the leftover
content pane.

`before-desktop-1440x900.png` — same two-pane chrome at 1440. The frame is
the intended desktop shape; its size inputs were still the platform flag and
the monitor width.

## After

`after-phone-390x844.png` — one column. Those desktop test IDs are gone.
Live shrink 1440→390 drops them without a reload.

`after-desktop-1440x900.png` — permanent navigation pane and resizer return
at 1440. Live grow 390→1440 restores them.

The fixture's `TypeError: guard is not a function` is a Workspace-list
reader miss on this audit server, not a layout regression; it is present
before and after and does not restore the two-pane chrome at 390.
