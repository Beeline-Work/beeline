# Corner swipe-right bottom sheet evidence

These are 390 × 844 captures of the real Expo web client against a fresh isolated
`@beeline/server` and PostgreSQL database, signed in as a disposable development
identity (`local:captain`) through `POST /v1/auth/github/exchange`. No mock
component and no production Workspace or account was used.

Swipe-right on a Room message now asks through `HullActionSheetModal` — the same
bottom sheet Room creation uses — instead of the centred `Modal.confirm` pop-up.
The corners-screen "New corner" dialog (the header `+`) moved onto the same sheet
in the same pass.

| Capture                                                      | Source                                                                |
| ------------------------------------------------------------ | --------------------------------------------------------------------- |
| [Reproduced pop-up](reproduced-popup-390x844.png)            | Base `main` build; swipe-right still opens the centred confirm dialog |
| [Swipe-right sheet](sheet-swipe-right-390x844.png)           | This branch; the same swipe presents as a bottom sheet                |
| [New corner sheet](sheet-new-corner-390x844.png)             | This branch; corners-screen `+` create sheet, title and apps intact    |
| [Forwarded corner](forwarded-corner-390x844.png)             | This branch; "Open a new corner" still creates it with the forward staged |

Measured in the branch bundle at 390 × 844: the swipe-right sheet surface is
`top 627 → bottom 844`, full width; the new-corner sheet is `top 497 → bottom
844`, full width. Both are anchored to the viewport's bottom edge. The swipe
gesture was driven with pointer events on the message row; the frames and these
measurements come from the actually-running branch bundle, not a fixture.

Desktop is untouched. The swipe-right flow returns early when `desktopExperience`
is set, so it never reaches this sheet, and `HullActionSheetModal` keeps its
`placement="center"` on desktop — the same presentation the centred dialog had.

## Capture recipe

1. Create and migrate a fresh local PostgreSQL database.
2. Start `@beeline/server` with `NODE_ENV=development`, a matching HTTP
   `PUBLIC_ORIGIN`, `BUZZY_AUTH_TENANTS_JSON`, and `BEELINE_WEB_APP_ORIGINS`
   containing the Expo web origin.
3. Start Expo web with `EXPO_PUBLIC_BUZZY_MONOLITH_URL` pointing at that server.
4. Exchange `local:captain` at `/v1/auth/github/exchange`, write the returned
   refresh token and identity id into `sessionStorage` under
   `buzzy.monolith.refresh.v1` and `buzzy.monolith.identity.v1`, then open the
   Welcome Room.
5. Use the named `chrome-devtools-axi` session at 390×844 to swipe a message
   right and capture. The reproduced pop-up uses the base-commit bundle on the
   same server and data.