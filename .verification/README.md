# Beeline design consistency — Android verification

Captured at 1080 × 2400 on the shared `buzzy_api36` Android emulator.

| Surface            | Before                          | After                                                                   |
| ------------------ | ------------------------------- | ----------------------------------------------------------------------- |
| Compose menu       | `before-compose-menu.png`       | `after-compose-menu.png`                                                |
| Workspace settings | `before-workspace-settings.png` | `after-workspace-settings.png` and `after-workspace-settings-lower.png` |
| Empty Room         | `before-empty-room.png`         | `after-empty-room.png`                                                  |
| Empty Corner       | `before-empty-corner.png`       | `after-empty-corner.png`                                                |

The before captures reproduce the critique baseline. The after captures use the signed release APK built from this branch; the branch bundle was loaded without the shared emulator's cached production OTA overriding it.

## Typed read-model proof — mobile viewport

The committed `read-model-proof.html` fixture renders only selector-shaped data at a
430 × 932 mobile viewport. It covers the three required surfaces from the immutable
snapshot contract:

| Surface    | Capture          | Evidence                                                                                      |
| ---------- | ---------------- | --------------------------------------------------------------------------------------------- |
| Transcript | `transcript.png` | Human and agent messages remain chronological while retry telemetry is collapsed as activity. |
| Roster     | `roster.png`     | Current human and agent identities are resolved from member pubkeys.                          |
| Corner     | `corner.png`     | A live corner has a human member and renders its selector-owned status.                       |

The HTML fixture is kept beside the captures so the exact visual input is reviewable
and reproducible without a relay or mutable presentation cache.
