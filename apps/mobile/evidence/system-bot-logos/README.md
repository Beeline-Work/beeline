# System bot logos

The `app-*.png` images capture the **signed-in Expo web app**, exported from this
branch in production mode at a 430 px phone viewport. The app read a seeded
local Beeline server through its normal phone API. The fixture data is local;
these are not production-account or native-device screenshots. The header,
Messages list, Workbench, and receipt cards are the shipped app screens and
components, with no proof layout wrappers.

- `app-trusty-squire.png` and `app-wallet.png` show each DM header and its
  `ConnectorReceiptCard` with the logo. `app-system.png` shows the System DM
  header; its announcement prose intentionally has no avatar.
- `app-tailscale.png` and `app-google-*.png` show the other connector DM headers
  and receipt cards.
- `app-messages-list.png` and `app-messages-list-lower.png` show the bot logos
  and names in the real Messages list.
- `app-workbench.png` and `app-workbench-google.png` show the tool rows.

The local server is `.verification/design-audit/fixture-server.mts`, extended
with system-bot DMs and receipt messages. The browser walk is
`.verification/design-audit/bot-logos.mjs`. Start the fixture server, export
the Expo web app with `EXPO_PUBLIC_BUZZY_MONOLITH_URL=http://127.0.0.1:4310`,
serve the export at `http://localhost:8081`, and run the browser walk with a
Chrome CDP endpoint at `127.0.0.1:9222`. The script signs in through the app's
`/review/<secret>` route and asserts the header and receipt test IDs before
capturing each DM.

`dark.png` and `light.png` are earlier component captures. Their header and
card layouts are proof wrappers, so they are not evidence for the app screens.
