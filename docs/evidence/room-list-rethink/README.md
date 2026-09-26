# Room-list rethink — real-app evidence

These frames come from the real Expo web client and authenticated phone API, not the
design board. The proof account was the development-only `local:roomlistproof` identity
(`Aster Vale`) in a disposable local PostgreSQL database and the isolated `Proof Flight`
Workspace.

## Frames

- `desktop-filters-before-1180x900.png` — the desktop filter treatment from a clean
  checkout of base commit `fb71db5dddcd2b41a7958aa419fce3ad084bde11`.
- `desktop-filters-after-1180x900.png` — the same authenticated data and viewport on this
  branch, including the selected-Room treatment.
- `desktop-room-list-after-1180x900.png` — the compact Room and direct-message sections.
- `desktop-corners-expanded-1180x900.png` — one Room expanded to show its waiting,
  review, and working corners nested below it.
- `mobile-room-list-after-390x844.png` — the responsive 390×844 list with one bordered
  card per section.
- `mobile-banner-arrival-390x844.png` — a foreground approval arrival below the app
  chrome.
- `mobile-banner-burst-390x844.png` — two arrivals collapsed into one `2 new` plate.
- `mobile-banner-tap-open-390x844.png` — after tapping the banner: it is dismissed and
  the exact `notificationMessageId` is open in `#Launch room`.

## Capture recipe

1. Create and migrate a fresh local `@beeline/server` PostgreSQL database.
2. Start the server on `127.0.0.1:19091` with `NODE_ENV=development`, a matching local
   auth tenant, and `BEELINE_WEB_APP_ORIGINS=http://127.0.0.1:19006`.
3. Exchange `local:roomlistproof` through `POST /v1/auth/github/exchange`, write the
   returned refresh token and identity id into the browser session stores, and seed the
   disposable Workspace with the Rooms, DM, messages, pending approval, pin, read marks,
   and three corners shown here.
4. Start this branch with
   `EXPO_PUBLIC_BUZZY_MONOLITH_URL=http://127.0.0.1:19091 npx expo start --web --port 19006`.
5. Use the named `chrome-devtools-axi` session `room-list-1730` to resize, interact, and
   capture at 1180×900 and 390×844. Banner frames use the component's development-only
   web event bridge because Expo does not emit notification-received events on web; they
   still render and route through the production banner component.
6. For the filter comparison, stop the branch server, archive the exact base commit into
   a temporary clean checkout, build its workspace packages, start its Expo web client on
   the same port, capture the same account/data at 1180×900, then remove that checkout.

No production Workspace or account was accessed.
