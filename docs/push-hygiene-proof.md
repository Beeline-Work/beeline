# OTA-safe push hygiene — 2026-09-12

Runtime remains **23**, with the Expo config, native fingerprint configuration, and recorded fingerprints unchanged from main. This change delivers view dismissal, foreground suppression, and the server-owned unread divider through the existing native APIs. Deploy the optional server read-cursor projection before the OTA.

Android native Room grouping and automatic empty-summary cleanup are deferred to [PR #1138](https://github.com/Beeline-Work/beeline/pull/1138), which needs a native release. They are not part of this OTA. iOS already consumes the APNs Room thread id from #1132.

## Validation

- `npm run typecheck`.
- Focused mobile dismissal, foreground policy, divider-cell/session, lifecycle folding and rendering tests.
- Server platform payload fixtures, Room read latency, and database-backed Room/corner cursor tests, including subsecond message ordering and optional-field compatibility.
- Runtime-23 native fingerprint check and production Android bundle export.

The cursor comes from the server before mark-read advances. It remains anchored for the visit and resets on refocus; a live arrival uses the existing post-paint Room refresh. No local mark store or guessed boundary is introduced. If the first unread row lies outside the loaded transcript window, the divider waits for that exact row to load.

## Demonstrated

**Final proof is the captain's phone after release.** Previous development checks used a temporary harness on a fresh runtime-24 API 36 emulator (`emulator-5560`), with the native grouping changes that are now deferred to #1138. They exercised real FCM receipt, the production foreground policy and dismissal helper. They are supporting evidence, not proof of an OTA received by an installed runtime-23 phone. The old runtime-21 rig was not used; no iOS device proof is claimed.

These retained screenshots render fixture rows using the production divider cell. They establish appearance and placement only; the hook and database tests establish server cursor behavior. The harness was removed from the shipping entry point.

[Divider fixture](screenshots/push-hygiene/empty-summary-divider-fixture.png) · [Reopened fixture without divider](screenshots/push-hygiene/reopened-divider-fixture.png)
