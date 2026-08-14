# Corner UX verification, API 36

Captured on `emulator-5554` from the signed production APK (`versionCode 25`) with an isolated throwaway reviewer identity and Workspace.

- `corner-open-chip.png`: after the permission grant, the Room contains one compact `CORNER OPEN` link. The matching lifecycle card is suppressed.
- `corner-activity-readable-expanded.png`: the corner activity stream collapses reads, replaces tool plumbing with past-tense action lines, reports the code-search failure plainly, and reveals sanitized raw output only after tapping the search row.

The review fixture uses `scripts/ui-demo-provision.ts`; it creates ephemeral relay records under a unique `uidemo-*` marker.
