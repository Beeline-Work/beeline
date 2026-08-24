# Beeline design consistency — Android verification

Captured at 1080 × 2400 on the shared `buzzy_api36` Android emulator.

| Surface | Before | After |
| --- | --- | --- |
| Compose menu | `before-compose-menu.png` | `after-compose-menu.png` |
| Workspace settings | `before-workspace-settings.png` | `after-workspace-settings.png` and `after-workspace-settings-lower.png` |
| Empty Room | `before-empty-room.png` | `after-empty-room.png` |
| Empty Corner | `before-empty-corner.png` | `after-empty-corner.png` |

The before captures reproduce the critique baseline. The after captures use the signed release APK built from this branch; the branch bundle was loaded without the shared emulator's cached production OTA overriding it.
