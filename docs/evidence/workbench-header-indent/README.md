# Workbench desktop header indent evidence

These captures come from the real Expo web app at 1440×900, signed in as the
development `local:captain` identity against an isolated local `@beeline/server`
and PostgreSQL database (migrated normally, identity minted through
`POST /v1/auth/github/exchange`, `docs/evidence/desktop-workspace-rail/seed.sql`
supplied the Workspace). The "before" pair is the pre-change bundle; the
"after" pair is the same window with the shared `PageHeader` in place.

## Measured left edge of each title (px, 1440-wide window, content pane starts at 280)

| Screen    | Before | After |
| --------- | ------ | ----- |
| Workbench | 488    | 292   |
| Bookmarks | 292    | 292   |

The before Workbench title was indented because its title came from the
navigation stack header, whose desktop layout centers a legacy 800px
`layout.headerMaxWidth` column and then adds its own padding; the hand-rolled
section headers are left-aligned at the content pane. After the change the
Workbench page draws the same shared `PageHeader` that Bookmarks draws, so both
titles share the pane's 12px inset.

## Capture recipe

1. Start an isolated PostgreSQL 17 database and run the release migration with
   both `DATABASE_URL` and `MIGRATION_DATABASE_URL` pointed at it.
2. Start `@beeline/server` with `NODE_ENV=development`, an HTTP `PUBLIC_ORIGIN`,
   matching `BUZZY_AUTH_TENANTS_JSON`, the five non-secret OIDC development
   placeholders, and both Expo origins in `BEELINE_WEB_APP_ORIGINS`.
3. Start Expo web with `EXPO_PUBLIC_BUZZY_MONOLITH_URL` pointed at that server.
4. From the Expo origin, exchange `local:captain` at
   `/v1/auth/github/exchange`, then write the returned refresh token and
   identity id to `sessionStorage` under `buzzy.monolith.refresh.v1` and
   `buzzy.monolith.identity.v1`.
5. Apply `docs/evidence/desktop-workspace-rail/seed.sql`, open
   `/beeline/channels`, and use the desktop sidebar to reach Workbench and
   Bookmarks at 1440×900.
