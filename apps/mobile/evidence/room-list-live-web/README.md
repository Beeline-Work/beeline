# Authenticated Room-list web check

These refreshed captures come from the Expo web app on this branch, signed in through its
`/review/<secret>` route against the isolated local Beeline server in
`.verification/design-audit/fixture-server.mts`. The server uses the real phone
API and seeded database records. This is an authenticated web session with live
API reads, not production user data or a connected device.

The Chromium walk covered a 1440×900 desktop window and a 390×900 phone window.
It confirmed the search field is visible at rest, the Bookmarks mark uses the
brass accent, the pin glyph has an accessible Pinned label, and DM rows show the peer name once.
The Messages heading and first DM row now sit closer together. At the default
280px desktop sidebar width, all three filters remain visible above search.
Desktop Room rows put the author and excerpt in a compact two-line block, as in
the supplied Obsidian reference mock in `../room-list-reference/`.
In both, the list showed the seeded Room, empty Room, and direct message with
their previews; All, Unread, and Pinned filters worked; search found a
Room and showed the no-match state; pinning survived reload; and Room and DM
rows opened their transcripts. The desktop corner disclosure fetched its corner
from the server and selected it in the work pane from an initially empty Room
deck. The phone corner summary opened the existing Corners list. The desktop
new-Room dialog and phone compose menu also opened. The final walk reported no
page errors, console errors, or horizontal document overflow at either width.

- `desktop-list.png` and `mobile-list.png` show the authenticated lists.
- `mobile-dm.png` shows the DM row without a repeated peer byline.
- `desktop-corner.png` shows the Room transcript beside the corner work pane.
- `phone-pin-menu.png` and `desktop-pin-menu.png` show the long-press action.
- `phone-pinned.png` and `desktop-pinned.png` show the saved pin after reload,
  with Pinned selected by default.
- `phone-no-pins.png` and `desktop-no-pins.png` show the empty Pinned view after
  unpinning the last Room.

To repeat the session, start the fixture server with
`AUDIT_WEB_ORIGIN=http://localhost:8082 node --import tsx .verification/design-audit/fixture-server.mts`,
then start Expo from `apps/mobile` with
`EXPO_PUBLIC_BUZZY_MONOLITH_URL=http://127.0.0.1:4310 npx expo start --web --port 8082`.
Open `http://localhost:8082/review/design-audit-review-secret-0001` in a browser.
