# Desktop Workspace rail evidence

These captures come from the real Expo web app signed in as the development
`local:captain` identity against an isolated local `@beeline/server` and
PostgreSQL database. The server was migrated normally, the identity was minted
through `POST /v1/auth/github/exchange`, and [`seed.sql`](./seed.sql) supplied
two Workspaces: populated `Burd Nest` and empty `Empty Flight`.

## Reproduced

[`reproduced-switcher-1440x900.png`](./reproduced-switcher-1440x900.png) is the
real-app 1440×900 capture of the previous desktop switcher. It replaces the Room
list with labeled tiles while leaving the rest of the application at full
brightness.

## Demonstrated

- [`rail-open-hover-1440x900.png`](./rail-open-hover-1440x900.png) shows the
  76px overlay rail and scrim at 1440×900. `Empty Flight` is current, while the
  short brass pill on `Burd Nest` carries the Room list's unread/needs-you
  signal. The pointer label shows `Burd Nest · 1 Rooms`.
- [`rail-open-hover-1920x1080.png`](./rail-open-hover-1920x1080.png) shows the
  same rail, scrim, current ring, attention pill, and hover label at 1920×1080.
- [`pick-landed-populated-1920x1080.png`](./pick-landed-populated-1920x1080.png)
  shows a pick closing the rail and routing from the empty Workspace to
  `Burd Nest`'s first Room, `#General`.

The rail was also opened with Ctrl+Shift+S, closed with Escape and its scrim,
and navigated with ArrowUp/ArrowDown plus Enter. Chrome reported no console
errors after the capture pass.

## Capture recipe

1. Start an isolated PostgreSQL 17 database and run the release migration with
   both `DATABASE_URL` and `MIGRATION_DATABASE_URL` pointed at it.
2. Start `@beeline/server` with `NODE_ENV=development`, an HTTP
   `PUBLIC_ORIGIN`, matching `BUZZY_AUTH_TENANTS_JSON`, the five non-secret OIDC
   development placeholders, and both Expo origins in
   `BEELINE_WEB_APP_ORIGINS`.
3. Start Expo web with `EXPO_PUBLIC_BUZZY_MONOLITH_URL` pointed at that server.
4. From the Expo origin, exchange `local:captain` at
   `/v1/auth/github/exchange`, then write the returned refresh token and
   identity id to `sessionStorage` under `buzzy.monolith.refresh.v1` and
   `buzzy.monolith.identity.v1`.
5. Apply [`seed.sql`](./seed.sql) after the exchange, open `/beeline/channels`,
   and use Chrome DevTools at 1440×900 and 1920×1080.
