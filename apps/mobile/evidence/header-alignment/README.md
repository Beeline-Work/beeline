# Room-list header alignment — Reproduction R1

The owner reported members and tray too far apart, trailing controls on different centre lines, and undersized section labels, counts and add glyphs. The approved option B has a solid person head behind an outlined bot head with pill eyes, without an antenna or bodies.

The reproducible local fixture uses the production Button, MembersAgentsGlyph, TrayGlyph, RoomListToolbar, RoomListSectionHeader, SettingsRow and theme tokens. The header uses the same 16px trailing inset and touching action boxes as the production phone route and desktop sidebar. Synthetic local data avoids changes to an owner's account. Its Settings and Tray specimens exercise the shared section header; they are not authenticated production route captures. The original owner's signed-in device and screenshot state are not reproduced by the fixture.

The web baseline loads the six affected production modules from `b82f0f7fb`; the final render loads this branch. Both phases use identical local content and viewport. The baseline fixture measures 56px members-to-tray separation, rather than the owner's reported 62dp; both expose the same padded-button defect. At 390px wide, baseline tray/search/add centres are 346/360/366px. Final centres are all 352px (width minus 38), members-to-tray separation is 44px, and all phone action boxes are 44px square. The add glyph is 22px, heading is 13px with tracking 2, count is 15px, and the action header is 44px tall. `web-measurements.json` contains the measured DOM geometry in both themes and at desktop width. Desktop retains its tap-line wrapper and header-height behavior.

The tray badge is positioned relative to a 22px icon landmark, rather than the enclosing button. Dedicated sectionLabel and sectionCount roles keep unrelated compact chrome and badge typography unchanged.

The final native release fixture also passes R1 on Android 36 at 1080×2340 / 420dpi. Members and tray centres are 329.524dp and 373.524dp, exactly 44dp apart. Tray, search, Rooms + and Corners + all centre at 373.524dp in both themes; width minus 38 is 373.429dp (rounding error below 0.1dp). Accessibility bounds are about 44dp square (pixel rounding below 0.2dp). Native Settings/Tray shared-header specimens were captured in both themes.

## Captures

- `android-{before,after}-{bone,obsidian}.png`, native accessibility XML and measurement JSON
- `android-after-{settings,tray}-{bone,obsidian}.png`
- `phone-before-{bone,obsidian}.png` and `phone-after-{bone,obsidian}.png`
- `desktop-before-{bone,obsidian}.png` and `desktop-after-{bone,obsidian}.png`
- `{phone,desktop}-{settings,tray}-{bone,obsidian}.png`

## Reproduce

From the repository root, run `node --import tsx apps/mobile/scripts/render-header-alignment-proof.mjs`, then the same command with `PROOF_PHASE=before`. Serve `.verification/header-alignment` on local port 19327 and run `python3 apps/mobile/scripts/header-alignment-proof/capture-web.py`. The script checks phone geometry and typography before saving captures. The web proof uses react-native-web and native platform shims; it does not prove sign-in, server mutation, or Android layout.

For the native baseline, `python3 apps/mobile/scripts/header-alignment-proof/build-before.py` temporarily loads the six baseline modules, builds a second APK and restores the final sources in a finally block. It also saves a recovery copy in `.verification/header-alignment/restore-final-sources.json`.

The native fixture entry is `scripts/header-alignment-proof/native.tsx`. Generate the ignored Android project with Expo prebuild, set its `react.entryFile` to that entry and disable Expo Updates in the generated manifest. Build `assembleRelease -PreactNativeArchitectures=x86_64 --no-daemon --max-workers=2`, install only on a task-owned emulator launched with `beeline emulator`, and run `capture-android.py <serial> <phase>` from the repository root. The Android capture script sets a 1080×2340 viewport at 420dpi and measures accessibility target bounds in dp.

## Validation and scope

Root typecheck, the shared UI component scanner (including comparison with origin/main), all 29 UI policy tests, all 106 affected component/route tests and both design lints pass locally. The complete mobile run and its local fingerprint limitation are recorded below. CI remains the merge authority. The first-party mobile UI policy prerequisite from PR #2785 is included so the existing onboarding/lifecycle violations do not mask this change. No new policy exception is added. The separate onboarding audit corner owns the broader onboarding migration.

The older `ui-alignment-proof/build.mjs` was also attempted for actual Settings/sheet route captures; its existing shims no longer satisfy native TurboModuleRegistry and identity exports. The focused fixture is the working stand-in, and that older harness is unchanged.

## Mobile suite fixture repair

The mobile CI failure exposed six hand-written theme mocks without the new sectionLabel/sectionCount roles. The fixtures now include those roles, and the Members/roster target assertions check the actual 44px boxes rather than the retired hit-slop geometry. All 129 tests in the six affected files pass locally, along with root typecheck.

The complete local mobile run covered 601 files: 596 passed, four skipped and one failed (nativeFingerprint.test.ts). Its test totals were 4,859 passed, five skipped and one failed. The remaining failure is a local native stamp mismatch; it persists after moving the generated Android proof project out of the app and when rechecked with Node 22. CI passed that same fingerprint test on the preceding head. Native configuration and runtime pins are unchanged; the local fingerprint issue is recorded rather than hidden or fixed through an unrelated runtime bump.
