# Android Back during live updates

Reproduction **BACK-BURST-1**: open Rig room 001, tap its visible rig-corner-001 row, then tap header Back during a Workspace-wide live burst. Back queued behind unnecessary React renders. The same burst delayed Room→list and DM→list.

The transcript subscribed to every change in the Workspace chat-list DTO, including other Rooms' message previews. Count badges subscribed to complete Tray entries, so replacing rows with the same count synchronously rendered the deck again. Both subscriptions amplified the same burst. Transcript subscriptions now compare the metadata they display; badges subscribe to the visible count. The canonical stores still receive every committed delta. Other local interactions read the latest canonical list ordering. Room names, membership, repository names, DM identities/presence and current-Room calls/state still update.

## Reproduced and demonstrated

The same leased Android emulator, disposable PostgreSQL fixture, local proxy, native probe and build flags were used before and after. All timing samples below were captured **without profiling**. The native timer starts at touch-up and ends at the frame commit containing the destination marker. It measures submitted visible content, not physical display scanout or a physical-phone guarantee.

| Back path | Idle before, median ms | Burst before, median ms | Idle after, median ms | Burst after, median ms | Burst after, range ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| corner→Room | (120) | (2681) | (116) | (118) | (114–159) |
| Room→list | (193.5) | (1790) | (197) | (213) | (194–238) |
| DM→list | (200) | (1435) | (185) | (191) | (175–200) |

Each before-idle case has (10) samples; every other table case has (5). [results.json](results.json) retains every accepted native mark, injection timestamp, scheduling gap and range. Every accepted mark was checked against its raw log; none was profiled. Warmups, the initial stronger burst, proxy isolation and profiles are excluded from this table.

The injection updates (25) fixture messages across (25) Rooms over approximately one second. Each write emits a message delta and a needs-you delta. The proxy independently recorded **(50) downstream messages spanning (961–972 ms)** for every primary before/after corner sample. The burst therefore reached the wire within one second even while the old JS receiver took much longer to process it. Configured RTT was (100 ms), with zero jitter and (10 Mbps). This is cleartext local HTTP/WebSocket shaping, excluding TLS and real radio behavior.

The fixture has (25) Rooms, (300) corners, one DM, over (10,000) older Room activity rows, and (1,000) older rows each in the corner and DM. Room reads remain bounded; this does not claim that all historical rows render at once. Two synthetic newest marker/source rows are future-dated to keep the native destination probe stable. Both builds use the same markers and data. The source-backed corner row is tapped through the real UI; deep-linking the corner was rejected as a substitute because repeated intents do not preserve the same navigation stack.

The APKs are release/Hermes/x86_64 builds, API (35), on a Beeline-leased `se_api35` emulator with SwiftShader, four guest cores, (2560 MiB), and a (1080×2400) display. Host: Intel Core i9-10900K. No additional CPU quota or physical-device calibration was applied. Baseline source: `14acbe60b`. APK SHA-256 digests are in the results file. No builds or test suites ran during acceptance captures.

Returned screens also accepted input: [Room composer](typing-room.png) and [Room-list search](typing-list.png). These are functional checks after navigation, not additional latency measurements.

## Trace and causal controls

The raw Hermes profiles, exact generated source maps, native/device logs, proxy/SQL logs, diagnostic patches and capture outputs are delivered in the accompanying Beeline trace artifact. Profiled native marks explicitly carry `profiled:true` and are not acceptance results.

Symbolication uses each Hermes frame's `funcVirtAddr + offset` against that APK's generated Hermes source map with `@jridgewell/trace-mapping.originalPositionFor`. Console frame timestamps align the profile's monotonic clock with device native marks. In the **strict tap-to-paint windows**, the baseline has React renderer/commit stacks in (924 of 959) samples; synchronous React work appears in (637). The fixed windows have (24) samples total across two shorter diagnostic captures. The baseline had three diagnostic captures, so these totals are not equal-duration sampling percentages.

The baseline primary corner runs contain (55) long event-loop scheduling gaps overlapping tap-to-paint, with a maximum observed timer interval of about (332 ms). The fixed runs contain (4), with a maximum around (127 ms). The probe is a nominal (16 ms) interval logging delays above (65 ms): it measures scheduling delay, **not exact Long Task API boundaries**. The profile supplies the CPU-work attribution. Native frame times remain independent of that JS timer.

Keeping the APK unchanged and filtering only one event type at the local proxy isolated both sources:

- Message deltas alone: corner Back (322–544 ms).
- Needs-you deltas alone: corner Back (629–920 ms).
- Both, unfiltered: corner Back (2509–2817 ms).

The proxy filter was removed before fixed acceptance captures. Additional fixed-build controls updated corner facts and cumulative drafts; their Back ranges were (136–232 ms) and (115–119 ms), respectively. Those controls have different server fanout and are not counted as the primary (50)-message matrix.

## Navigation and earlier PR audit

At the baseline revision:

- `_chat-surface.tsx:5242` handles Room, corner and DM Back synchronously: stop the draft timer, inspect the local stack, and dismiss/back/replace. It awaits no response. Its native `beforeRemove` listener at `:855` also stops the local draft timer.
- `corner-navigation.ts:179` resolves the destination from stack and route hints only.
- `useRoomSurfaceSession.ts:462` can signal a covering read on refocus; it does not await that read before retaining the Room. The session effect at `:584` remains activated after first focus.
- `channels.tsx:336` starts missed reads on list refocus; the focus callback at `:541` does not await them. The existing list DTO remains available.
- A lone corner can replace itself with a parent Room that has never been opened (`_chat-surface.tsx:5252`). An uncached destination renders a loader at `:6053–6104` until its opening response arrives. This cold fallback is a separate network-dependent destination; it is not the mounted-screen reproduction fixed here.
- The monolith socket parses JSON then synchronously dispatches (`live-connection.ts:453`). Its authenticated draft DTO path (`useRoomSurfaceSession.ts:981`) bypasses the legacy Nostr signature decoder (`:1032`). Signature verification does not explain this measured burst.

The affected chat-list and needs-you store files are byte-identical between the parent of PR #2852 (`e23bcc069^`) and this baseline. Their broad subscriptions predate both PR #2850 and #2852. PR #2852 retains mounted Room sessions, which can amplify existing subscriptions; this investigation does not claim a matched pre-#2852 APK comparison. The fix targets the independently reproduced fanout on current main and does not revert the earlier navigation fixes.

## Repeating the proof

Read `scripts/latency-rig/README.md`. Use separate baseline and PR-head checkouts with dependencies prepared; copy this evidence directory to both. Use one explicitly owned Beeline-leased emulator, one disposable loopback `latency_rig` database and the same server/proxy throughout the comparison. Do not use a production Workspace.

Start the local server/proxy with a local-only review secret, RTT (100 ms), zero jitter and (10 Mbps). After the standard rig seed, run:

```sh
node apps/mobile/evidence/android-back-live-burst/seed.mjs
```

`LATENCY_RIG_DATABASE_URL` is required and guarded against non-loopback/non-fixture writes. Seeding makes the fixed fixture and source-backed corner row. Keep its data between builds; the burst reuses stable message IDs.

For each local fixture APK, temporarily apply the diagnostic patches before `build-local.sh`. They instrument event-loop gaps and event receipt/dispatch, bound Metro workers, and extend only the emulator-only native probe to recognize list destinations:

```sh
git apply apps/mobile/evidence/android-back-live-burst/instrumentation.patch
git apply apps/mobile/evidence/android-back-live-burst/native-probe.patch
bash scripts/latency-rig/build-local.sh
git apply -R apps/mobile/evidence/android-back-live-burst/native-probe.patch
git apply -R apps/mobile/evidence/android-back-live-burst/instrumentation.patch
```

Set `EXPO_PUBLIC_BUZZY_MONOLITH_URL` to the emulator-host proxy port before building. Install on the owned device, use the local review sign-in, and select **Latency Rig 25**. Warm the Room, corner and DM, then allow installation work to settle for at least (30 seconds). Preserve the native display size and animation defaults.

```sh
export LATENCY_RIG_DEVICE=<owned-device>
export LATENCY_RIG_OUTPUT=<separate-output-directory-for-this-build>
python3 apps/mobile/evidence/android-back-live-burst/capture.py idle corner 10
python3 apps/mobile/evidence/android-back-live-burst/capture.py spread corner 5
python3 apps/mobile/evidence/android-back-live-burst/capture.py spread room 5
python3 apps/mobile/evidence/android-back-live-burst/capture.py spread dm 5
```

Repeat idle Room and DM paths as well. The driver assumes the recorded display geometry, taps the real corner row and header Back, and fails if the destination's native visible frame never arrives. Profiling uses the stock rig receiver's `LATENCY_RIG_PROFILE` start/stop broadcasts and must be captured separately from acceptance timing. The helper also supports `corners` and `draft` controls.

## Verification

The two new render regressions fail on the original store code: an unrelated burst renders the transcript consumer and count badge (25) times each. After the fix, those consumers render zero times for the same unchanged display values; the full store still contains the newest message, and Tray content still changes without changing the badge count.

Focused mobile suites pass (113 tests; one existing skip), including the existing Chrome Tray user-path proofs. Root `npm run typecheck`, `npm run dead-code`, workflow-path lint, syntax checks for these proof helpers and `git diff --check` pass. No dead-code baseline or CI check names were changed. No server, iOS or release work was performed.
