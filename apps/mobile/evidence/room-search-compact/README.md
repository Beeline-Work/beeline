# Room search size — ROOM-SEARCH-SIZE-1

Open the Room list, tap Search conversations, and compare the empty and typed
field with the All / Unread / Pinned row. Before this change the search wrapper
uses 64 dp and body text (16); after it uses 44 dp and meta text (13), with the
same left and right text insets. The shared search and sheetSearch variants
keep their existing geometry.

## Android: real application

These are unmodified device captures from the full Beeline development app on
a Beeline-leased API 36 x86_64 emulator, 1080 × 2400, density 420. The app runs
against a disposable local PostgreSQL database and the real monolith, with its
local-only reviewer sign-in. These are not production-session screenshots or a
component fixture. The floating gear is the development client's Tools control.

| State | Before | After |
| --- | --- | --- |
| Search open, empty | [Before](before-android-empty.png) | [After](after-android-empty.png) |
| `proof` typed | [Before](before-android-typed.png) | [After](after-android-typed.png) |

Both typed states retain #proof and remove #general. Before, the native input
occupies y=448–551 inside the tall search wrapper. After, it occupies
y=416–531: its 115 physical pixels match the All button's 115-pixel target.
The search divider moves from y=583 to y=531, recovering approximately 20 dp.
The text already aligned with All in the baseline containing PR #2868; that
alignment is preserved. See [native bounds and visible results](android-measurements.json).

[Bone with system font scale 1.3](after-android-large-text.png) also keeps the
typed text readable and aligned, without clipping. Font scale was restored to
1.0 and night mode restored after this capture.

The baseline is the original toolbar and HullDialog from `14acbe60b`. The final
working-tree JavaScript was then served through Metro to the same installed
app and local account. [Source hashes](source-sha256.txt) identify that final
UI source; the build metadata still names the baseline commit because these
were uncommitted JavaScript changes during capture.

### Reproduce the local app proof

1. Run `npm run corner:prepare`. Lease an emulator with
   `beeline emulator -avd buzzy_api36 -no-window -gpu swiftshader_indirect`.
2. Create an isolated local database whose name contains `latency_rig`.
   Start `scripts/latency-rig/run-local.sh` with `LATENCY_RIG_DATABASE_URL`
   pointing to it, a disposable `LATENCY_RIG_REVIEW_SECRET`, server port 19463,
   proxy port 19462, and `LATENCY_RIG_RTT_MS=0`. This fixture stays local.
3. In apps/mobile, set `EXPO_PUBLIC_BUZZY_MONOLITH_URL=http://10.0.2.2:19462`,
   run `npx expo prebuild --platform android --no-install`, then build
   `:app:assembleDebug` with x86_64 and two Gradle workers. Install that APK on
   the explicitly selected emulator.
4. Start Expo's development server on port 19464 with the same server URL;
   reverse that port with adb and open its development-client link. Open
   `beeline://review/<local-only-secret>` to sign in to the disposable server.
5. In Beeline Review, tap Search conversations; capture with
   `adb -s <leased-device> exec-out screencap -p`. Type `proof` and capture
   again. Repeat after loading the changed source through Metro.

The first cold sign-in showed a Room-view timeout; Retry recovered. Startup
route warnings and the timeout were reported separately as Beeline feedback.
Neither required a change to this search fix.

## Shared desktop style and browser measurements

Desktop uses this same toolbar, so its search also becomes compact. The
existing full Room-list browser fixture uses real components with synthetic
data; it is supplementary evidence, not the Android proof above.

| View | Before | After empty | After typed |
| --- | --- | --- | --- |
| Phone, Obsidian | [Before](before-web-390.png) | [After](after-web-390-obsidian-empty.png) | [Typed](after-web-390-obsidian-typed.png) |
| Desktop, Obsidian | [Before](before-web-1280.png) | [After](after-web-1280-obsidian-empty.png) | [Typed](after-web-1280-obsidian-typed.png) |
| Phone, Bone | — | [After](after-web-390-bone-empty.png) | [Typed](after-web-390-bone-typed.png) |
| Desktop, Bone | — | [After](after-web-1280-bone-empty.png) | [Typed](after-web-1280-bone-typed.png) |

At widths 390 and 1280 in both themes, measured search height is 44, type is
13/19, and text starts at x=20, matching All. Right inset remains 6.61328.
The field fills the row apart from its divider. Typing filters the list;
closing search clears it. [Measurements](web-measurements.json).

Build this existing fixture with
`node --import tsx apps/mobile/scripts/render-room-list-proof.mjs` and serve
`.verification/room-list` from a free local HTTP port.

## Validation

The new SidebarView.navigation regression fails on the baseline with expected
44, received 64 in both phone and desktop modes. It now passes and checks meta
type, input expansion, divider, both insets, and query callbacks. The existing
HullDialog tests retain the other search variants' 64/52 geometry.

The toolbar/sidebar, HullDialog and design-lint suites pass (78 tests).
Root `npm run typecheck` and the component-policy scanner are also checked.
The scoped [Impeccable polish critique](polish-critique.md) records the visual
inspection, corrected touch-area finding, and clean detector result.
