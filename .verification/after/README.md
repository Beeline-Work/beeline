# Mobile design parity — after evidence

Captured on 2026-08-24 from the Android emulator (`emulator-5554`, 1080×2400) using a signed local release APK built from this branch. Expo Updates was disabled only in the ignored generated Android manifest for capture, so the installed app could not replace the embedded branch bundle with a cached production OTA.

The [complete route inventory](../inventory/README.md) found seven drifted route surfaces. Each is paired below with its pre-migration production capture. The migration is visual only: route behavior, settings behavior, and copy semantics remain unchanged.

| Migrated route/state | Before | After | Verified parity change |
|---|---|---|---|
| `/buzz/MembersScreen` | [before](../inventory/buzz-members-screen-before.png) | [after](buzz-members-screen-after.png) | The accidental route no longer adds a second legacy header around the canonical Members slab. |
| `/settings/appearance` | [before](../inventory/appearance-before.png) | [after](appearance-after.png) | Flat slab header and hairline groups; Space Grotesk prose and mono chrome; shared `SettingsNavigationRow`; 3px controls. |
| `/settings/agents` | [before](../inventory/settings-agents-before.png) | [after](settings-agents-after.png) | Provider cards and multicolor icons become one flat, hairline settings index with semantic prose/mono values. |
| `/settings/features` | [before](../inventory/features-before.png) | [after](features-after.png) | Rounded cards, rainbow icons, and generic pill switches become flat rows and shared 3px box toggles. |
| `/settings/language` | [before](../inventory/settings-language-before.png) | [after](settings-language-after.png) | The list uses the shared header, mono section label, hairline rows, and palette check; the previously blank header now names the destination. |
| `/changelog` | [before](../inventory/changelog-before.png) | [after](changelog-after.png) | Release notes now use a slab header, mono ledger metadata, Space Grotesk content, and hairline seams. |
| `/text-selection` (missing-id state) | [before](../inventory/text-selection-before.png) | [after](text-selection-after.png) | Glass content/native Alert and generic icon are replaced by a flat mono document surface, glyph action, and shared `HullActionSheet`. |

## Shared overlay verification

The language restart confirmation also moved from the native alert onto the shared hull primitive without changing its title, message, or Cancel/OK behavior:

- [`/settings/language` restart confirmation](settings-language-confirm-after.png)

## Result

- 7/7 drifted surfaces migrated and captured.
- 24/24 inventoried route files/states are canonical after the migration.
- Onboarding, add-Room, the Buzz settings family, and the principal Room/Corner surfaces were verified as already canonical and were intentionally left behaviorally and visually unchanged.
