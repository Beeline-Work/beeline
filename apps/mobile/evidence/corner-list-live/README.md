# Corner list freshness — Reproduction 5b25dbcb

The isolated Android and web comparison reproduces the owner's freeze on main
and passes on this branch. Both the parent Corners list and the corner header
update within two seconds in the accepted branch captures. No production
release or production data was used. Ruby approved this local replacement for
the production check; the owner will check production after merge and release.

## Results

Times start immediately before the remote write. Android values are conservative
**screenshot completion upper bounds**, including the deliberate navigation back
to the list. Web values observe the rendered state after two animation frames.
These are local fixture observations, not production latency percentiles.

| Platform/build | Change | Header | Corners list | Evidence |
| --- | --- | ---: | ---: | --- |
| Android main | archive | Still working at 3,151 ms, alongside archived pill | Still working at 5,743 ms | [header](android-main-archive-header.png), [list](android-main-archive-list.png), [recording](android-main-archive.mp4) |
| Android branch | archive | Archived by 631 ms | Removed from open rows by 1,744 ms | [header](android-branch-archive-header.png), [list](android-branch-archive-list.png), [recording](android-branch-archive.mp4) |
| Android main | start turn | Still idle at 3,427 ms | Still idle at 5,660 ms | [header](android-main-turn-header.png), [list](android-main-turn-list.png), [recording](android-main-turn.mp4) |
| Android branch | start turn | Working by 620 ms | Working by 1,594 ms | [header](android-branch-turn-header.png), [list](android-branch-turn-list.png), [recording](android-branch-turn.mp4) |
| Web main | archive | Still working at 4,988 ms, alongside archived pill | Still working at 4,988 ms | [header](web-main-archive-header.png), [list](web-main-archive-list.png) |
| Web branch | archive | Archived by 572 ms | Removed from open rows by 92 ms | [header](web-branch-archive-header.png), [list](web-branch-archive-list.png) |
| Web main | start turn | Still idle at 5,000 ms | Still idle at 4,999 ms | [header](web-main-turn-header.png), [list](web-main-turn-list.png) |
| Web branch | start turn | Working by 45 ms | Working by 45 ms | [header](web-branch-turn-header.png), [list](web-branch-turn-list.png) |

Web recordings: [main header](web-main-header.mp4), [main list](web-main-list.mp4),
[branch header](web-branch-header.mp4), [branch list](web-branch-list.mp4).
[measurements.json](measurements.json) records write timestamps, observed state,
Android screenshot start/end timestamps, and the 257-Room eviction barrier for
every accepted case. Android screenshots before each change are included as
`android-<build>-<change>-before.png`.

## Target and build isolation

Server and branch client product source: `4e064ac7e`. Baseline mobile product
source: main `6771892c615b63789d705740ce0794b48cceca9b`. Both clients used the
same branch server, disposable PostgreSQL 16 database
`beeline_latency_rig_corner_b2aa`, and loopback proxy. The server ran from the
branch TypeScript source after building its workspace dependencies. The fixed
server also sends the epoch to the main client, which ignores it and reproduces
the sequence-only dedupe failure.

Android: leased private `emulator-5562`, Android 15/API 35 x86_64 AVD `se_api35`;
Hermes release APKs, OTA explicitly disabled in the generated manifest
(`expo.modules.updates.ENABLED=false`), cleartext enabled only for this local
build, bundled endpoint `http://10.0.2.2:9181`, default disposable debug signing.
The existing emulator and Tap selection preview were not used. No native input
or app config overlay was committed to the product.

The APKs used the same generated native project and native dependencies. For
the baseline rebuild, all four changed mobile runtime files were restored
byte-for-byte from main: `room-corner-store.ts`, `use-room-corners.ts`,
`live-connection.ts`, and `monolith-rig-transport.ts`. All other bundled product
source was identical between these commits. Test and evidence files are not
bundled. The branch files and app config were restored afterward. Each APK was
installed on the private emulator with app data cleared and the disposable local
review identity redeemed before capture.

APK SHA-256:

- branch: `2883b8cd099e86d0151da263af68293c79e8624ed48f4a9f9a70a6e86edaee09`
- main: `b237a4fc6c6f560cb17accc306e23f8edd1eaf0984d5b5e711b0d6c2aa243ada`

Web: separate Expo production exports from those same mobile sources, served
at `http://127.0.0.1:9182`, endpoint `http://127.0.0.1:9181`, Chromium headless,
1100 × 850 viewport, fresh context and local reviewer sign-in for each build.
The list and header remain open in separate tabs during each change. The browser
workflow also inspected the local list; the dedicated capture script supplies
the timing and recordings. This is the approved replacement for
`web.usebeeline.app`, not a claim that production contains the fix.

## Reproduced and demonstrated

For every case under Reproduction 5b25dbcb:

1. Open the parent list and the corner header. Establish the initial visible
   state: archive-proof working, turn-proof idle.
2. Reset the fixture while these subscriptions are held. This commits the
   unchanged initial state and publishes parent status frames, establishing a
   stored sequence greater than the next history's sequence of 1. Without this
   priming, main could falsely pass because no prior status sequence was held.
3. Insert activity messages into **257 distinct other top-level Rooms**. Wait
   until the actual PostgreSQL live listener has published all 257 Rooms. They
   evict the quiet parent's history from the real LiveHub; no client connection
   is replaced.
4. Archive through the actual authenticated phone `requestCornerClose` HTTP
   operation. For the other case, commit a working `agent_turns` row for the
   fixture agent in the second corner. The real database triggers, listener,
   server projection, socket, client store, and UI carry both changes. The turn
   case exercises the committed start projection without provisioning a helper.
5. Record the header, then return to the already-open Android list; on web,
   observe both held tabs. Main retains the old shared row. The branch accepts
   the new epoch and paints the new state. The Android header recordings on main
   remain visible past two seconds before returning to the still-stale list.

Android screenshots were collected sequentially with `adb exec-out screencap`;
OCR was run **after** capture and checked against the linked pixels. A completed
screenshot bounds when its visible state was painted. Header samples first show
an unchanged state, then the passing state; list bounds include the back
transition. Screenrecord runs for ten seconds with a half-second lead before the
write. Host timestamps and that lead are recorded; video start is not treated as
an exact millisecond clock. Web timing uses a MutationObserver followed by two
requestAnimationFrame callbacks, with independent screenshots and videos.

The host emulator CPU is uncalibrated, the local proxy has zero injected RTT,
and HTTP excludes TLS and mobile-network delay. These measurements establish
that the stale-state path is fixed locally, not a physical-phone performance
claim.

## Reproduction kit

[proof-kit](proof-kit/) contains the exact local server controller, seed, web
server, and capture paths. Run from the repository root. The controller refuses
anything except the named loopback fixture database; it never uses production
keys. Its local reviewer session remains in memory. Install the temporary
Playwright dependency under `.local/corner-proof/automation` and set
`CORNER_PROOF_CHROMIUM` if the recorded Chromium path differs on your host.
Set `CORNER_PROOF_DEVICE` to your own leased emulator.

```sh
npm run corner:prepare
export LATENCY_RIG_REVIEW_SECRET=corner-list-isolated-review-2026
export LATENCY_RIG_RTT_MS=0
bash apps/mobile/evidence/corner-list-live/proof-kit/run-server.sh
```

In another shell, seed the two proof corners and 257 eviction Rooms:

```sh
node apps/mobile/evidence/corner-list-live/proof-kit/seed.mjs
```

Build each APK with the local endpoint, OTA disabled and x86_64 only, as above.
Build web with `expo export --platform web --max-workers 2`, setting
`EXPO_PUBLIC_BUZZY_MONOLITH_URL=http://127.0.0.1:9181`. Serve the selected export:

```sh
node apps/mobile/evidence/corner-list-live/proof-kit/serve-web.mjs .local/corner-proof/web-branch
python3 apps/mobile/evidence/corner-list-live/proof-kit/capture-android.py branch
node apps/mobile/evidence/corner-list-live/proof-kit/capture-web.mjs branch
```

Do not run Android and web mutations concurrently: they share the fixture.
Select `main` when capturing the baseline build. The capture scripts require
successful writes and initial states before accepting a trial.

Excluded runs: an incomplete fixture reset retained a terminal lifecycle;
unprimed exploratory captures did not establish a prior sequence; and one web
archive request hit the local review rate limit. None is in the table. The reset
now clears both archival and terminal lifecycle state, held lanes are primed,
the controller reuses its local session, and failed archive writes reject the
trial.

## Regression checks

The server/client stand-in in `room-corner-store.test.ts` failed against
unchanged main: expected idle, received working after 257-Room eviction. It
passes on the branch. Transport tests cover in-place epoch reset, duplicate
rejection and reconnect cursor scope. Server socket tests cover resending an
unchanged status after epoch change and dropping late old-epoch projections.
The mounted Corners test covers mount and foreground rereads while retaining
painted rows. Validation: 89 targeted mobile tests, 82 server socket/service
tests, root typecheck, and workflow path lint passed.
