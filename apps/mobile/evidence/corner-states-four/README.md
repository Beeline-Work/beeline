# Server-owned corner state proof

These are captures of the real Expo web app signed in as the development
`local:captain` identity against a local `@beeline/server`. They are not fixture
renders. The local database was migrated by the server and then populated with
[`seed.sql`](./seed.sql).

- `room-list-390x844.png` shows all four server-projected state words in one
  expanded Room row.
- `header-{working,waiting,review,archived}-390x844.png` shows the real corner
  header for each state. The waiting and review captures also demonstrate the
  header-only failure suffixes.
- `desktop-1440x900.png` shows the same four states in the real desktop work
  pane, with archived rows expanded.

Chrome DevTools reported no console errors after the capture pass.
