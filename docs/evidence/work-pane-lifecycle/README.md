# Desktop work pane lifecycle evidence

These paired captures come from the real Expo web app at 1440×900 and 940×900,
signed in as the development `local:captain` identity against an isolated
PostgreSQL 17 database and local `@beeline/server`. The app source was served by
Metro; no static fixture was presented as the application.

Each image reads left to right. Stories 8–10 include the meaningful intermediate
dragging or narrow state as a third frame.

1. [List row opens work pane](story-01.png)
2. [Corner card opens work pane](story-02.png)
3. [Pinned line opens work pane](story-03.png)
4. [Open in main leaves work overview](story-04.png)
5. [Close dismisses pane and reveals handle](story-05.png)
6. [Dismissed list-row click opens in main](story-06.png)
7. [Handle restores the work overview](story-07.png)
8. [Dragging a corner widens the handle and opens that corner](story-08.png)
9. [Narrow suppresses A and widening restores A](story-09.png)
10. [Narrow suppresses B and widening restores B](story-10.png)
11. [Dismissal survives an app reload](story-11.png)
12. [A newly opened corner auto-selects while A is present](story-12.png)

`seed.sql` supplies the initial Room and two corners after a normal server
migration and development auth exchange. `new-corner.sql` is applied only after
the Room is painted for story 12; a real authenticated Room message then drives
the server live invalidation and client refresh.
