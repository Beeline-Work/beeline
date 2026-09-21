# Desktop rail account hub, settings route, and boot URLs — evidence

All captures come from the real Expo web build of this branch (`apps/mobile`,
`expo start --web`) at 1440×900, signed into an isolated local monolith through
the product's own `/review/<secret>` route, driven over CDP.

The local monolith is `.verification/design-audit/fixture-server.mts` — the
server's own PGlite test-support wiring seeded with two Workspaces, Rooms, a
corner, and a Members roster — started on its own port with
`EXPO_PUBLIC_BUZZY_MONOLITH_URL` pointed at it.

One harness note: Expo's development-only LogBox toast host (`#error-toast`)
hit-tests over the bottom of the page in web dev builds and swallows synthetic
clicks. It is not in the shipped bundle, so the driver removes it before
pressing anything.

## Reproduced

- `rail-before-1440x900.png` — the desktop Workspace rail open (Ctrl+Shift+S) on
  `main`. Its whole command vocabulary is Workspace tiles plus one add tile; the
  probe read exactly `desktop-workspace-tile-<id>` ×2 and
  `desktop-workspace-add`. There is no account hub, and the rail's scrim covers
  the navigation pane that carries the only other way to it.
- Booting the app at a destination URL lost that destination. Sampling
  `location.pathname` every 500 ms:

      boot /beeline/settings      : /beeline/settings          -> /beeline/channels
      boot /beeline/chat/<roomId> : /beeline/chat/4399686f-...  -> /beeline/channels

- Every boot logged `[Layout children]: No route named "settings/index" exists
  in nested children` — `(app)/_layout.tsx` declares that screen, but its route
  file went with the sidebar simplification in #1431.

## Demonstrated

- `rail-after-1440x900.png` — the same rail on this branch. Below the add tile
  and its own separator sits the account hub, drawn with the viewer's identity
  mark and labelled `Alan — Settings`. Pressing it routes to `/beeline/settings`.
- `boot-url-kept-1440x900.png` — the app booted straight at
  `/beeline/chat/<roomId>` and stayed there. Booting at `/beeline/settings`
  likewise stays on the account hub; neither is replaced by the Room deck.
  (The red badge at bottom-left and the timing column at right are Expo's
  development LogBox and the dev room-open trace, not app chrome.)
- `/settings` now resolves: `/settings -> /beeline/settings`, and the boot logs
  carry no `[Layout children]` warning.
