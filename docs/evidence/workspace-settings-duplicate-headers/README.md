# Workspace settings — duplicate section headers removed

Fixture-backed render of the real `Workspace settings` screen
(`apps/mobile/sources/app/(app)/beeline/settings/workspace.tsx`, PR branch
`fm/beeline-workspace-settings-duplicate-headers`) on emulator-5554.

The screen was driven exactly as production renders it: a debug/release harness
APK (`app.usebeeline.harness`) with the branch's JS bundle embedded, pointed at
a throwaway local fixture server serving a valid `WorkspaceView`
("Tubing Crew", owner viewer, two managed rooms). No install, key, or session
of the production app was touched.

| File | What it shows |
|---|---|
| `workspace-settings-fixture.png` | Workspace settings screen: `WORKSPACE` block (Picture, Name), then `VISIBILITY` once, `MEMBERS` once, `ROOMS` (Put-in Point, River Run), `DANGER ZONE` |

Verified facts:

- `VISIBILITY` appears exactly once (previously a duplicated section head).
- `MEMBERS` appears exactly once (previously a duplicated section head).
- `WORKSPACE`, `ROOMS`, and `DANGER ZONE` section heads unchanged.
- Spacing sane: one hairline-separated block per section head, no orphan head
  above `VISIBILITY`/`MEMBERS`.
