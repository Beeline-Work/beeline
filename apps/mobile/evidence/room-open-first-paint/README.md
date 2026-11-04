# Phone Room first paint

Previously opened Rooms with a stored scoped DTO meet the 450 ms load budget in the alternating native Android A/B, including after a process restart. Values are milliseconds, `p50 / p95`, with ten samples per case per arm. Nearest-rank p95 is the maximum; no warmup or slow sample is discarded.

| Room open                        | Original task HEAD |       This change | After p95 ≤450 |
| -------------------------------- | -----------------: | ----------------: | :------------: |
| Cold process, stored Room reopen |  598.916 / 916.270 | 321.935 / 413.065 |      yes       |
| Warm reopen                      |  329.932 / 415.801 | 249.283 / 331.384 |      yes       |

These are native frame-completion proxies, not optical scanout measurements. The same complete, bounded 30-message response goes to the real inverted transcript, alongside the header and composer. Its first native render remains ten rows. No last-message overlay, extra UI control, client snapshot, new phone network site, or polling was introduced.

## What changed

- Restore the existing validated, reader/origin-scoped Room DTO synchronously from MMKV on the tap. A hot value or a fenced revision wins over disk; invalid/unavailable storage retains the ordinary read path. The first Room render receives the DTO rather than rendering an empty Room and applying the same stored response afterward.
- Replace the general retained-open swipe drawer with `TranscriptSwipeable`, the transcript's actual one-action gesture. It uses one translation value, one pan recognizer, the existing friction/half-panel threshold and reduced-motion-aware return spring. Hidden action artwork mounts when a swipe begins. Cancellation returns on the UI thread; both actions, long press, and the alive-ring clip gutter are preserved.
- Keep outbox/transport setup behind the existing visible-row draw barrier for cached, tap-owned opens. A JS animation callback can precede Fabric's native mount. Direct opens still start their own response without waiting for a tap-owned barrier, avoiding a read/draw cycle. Limit subsequent list work to four rows per batch and a five-viewport window; the initial ten-row window and full response are unchanged.

## Where the time went

The following are p95 values from the alternating Room A/B. Quantiles cannot be added. React Profiler measures render work, not commit duration. Layout callback timing includes native layout and JS delivery; the draw-to-completion interval is native HWUI evidence.

| Cold-open measurement                       |  Before |   After |
| ------------------------------------------- | ------: | ------: |
| Tap → cached response available             | 162.479 |  33.775 |
| Root render work through transcript commit  | 475.245 | 157.124 |
| Tap → transcript commit marker              | 646.254 | 261.979 |
| Tap → native content-size callback          | 681.241 | 363.004 |
| Transcript commit → native DrawStart        |  80.698 | 128.905 |
| Native DrawStart → FrameCompleted           | 323.190 |  40.348 |
| Tap → completed native frame                | 916.270 | 413.065 |
| Existing Room request → JS headers callback | 776.482 | 823.654 |

The fresh Room request remains necessary but is outside the first cached paint. This is a rendering/storage-path improvement, not a network-speed claim. A cache-miss first-ever Room read is not certified under 450 ms: it still needs the production response before rendering. The earlier exploratory uncached sample spent about 377 ms waiting for that response alone.

The diagnostic bundle that bypassed swipes isolated expensive row mounting. It is not product code and is excluded from acceptance. Two diagnostic log lines were truncated; those samples retain missing measurements. The paired acceptance builds use six-record log chunks and have all twenty native matches per arm.

## Other surfaces and the remaining open item

A separate pass of the measured Room code on the same emulator measured:

| Surface                 | Native proxy p50 / p95 | Result                   |
| ----------------------- | ---------------------: | ------------------------ |
| Room → Room list return |      165.614 / 250.815 | **open: exceeds 150 ms** |

**Keep Room-list-return latency as an open item in the PR body.** In its slowest retained sample, the content commit was at 156.380 ms, including 89.849 ms of Root render work (82.113 ms in its largest render). It then took 84.538 ms to reach native DrawStart and 9.896 ms to complete that frame. Returning still requires Room-list rendering and native Room teardown/layout. This change does not establish the universal interaction budget.

**Tray experiment excluded from the fix:** a held-response loading-gate experiment reached 113.558 ms native open p95, but its update budget did not pass. Needs-you Clear measured commit→rAF **88.821 / 206.142 ms** and Undo **79.248 / 151.740 ms**. Tap→rAF was **301.673 / 451.048 ms** for Clear and **219.555 / 373.594 ms** for Undo. The Tray product changes were removed; these are failed experimental results, not shipped speed claims.

Tray Needs-you CLEAR/UNDO uses the separately identified **commit+rAF proxy**, not an HWUI frame. A static Undo draw can precede the JS content marker, leaving no later HWUI match. The retained proxy records the committed React tree and its following `requestAnimationFrame` stamp; both commit→rAF and tap→rAF are reported in `tray-updates.json`. This proxy must not be described as compositor or native-frame completion.

## Native setup and boundaries

- Owned emulator **5634**, cloned configuration of `walkthrough40`: Android 35, 1080×2400 at 420 dpi, four cores, 1536 MB, SwiftShader; other workers' emulators were not driven.
- Existing native binary: runtime **40**, versionCode **27**, versionName **0.2.22**. Started with actual production **v0.1.142**, source `98c2a49a4f3df909e8fd3fc32ae39129f6f8367b`, and signed in as Play Review with the secret suppressed.
- Only Beeline Review Workspace `bee11e00-0000-4000-8000-000000000105` and proof Room `bee11e00-0000-4000-8000-000000000103`. The Room projection held thirty messages and one member. The shared proof account grew from eighteen to twenty-two list entries during the wider investigation; timing claims are limited to this fixture.
- Both acceptance arms use task HEAD `525dfedb5e1f351e4493a8c2bbf52f5d41a49568`, freshly compiled api-contract/nostr/net/buzz-client, the production origin, and identical profiling hooks. After overlays the Room changes plus the subsequently withdrawn Tray readiness experiment. That experiment changes only the Tray view and does not execute during Room-open acceptance samples; the measured Room code is unchanged in the commit. These are local profiling launch assets, not published OTAs. `provenance.json` records native/bundle hashes.
- Ten alternating trials, reversing before/after order on odd trials. Each arm captures cold then warm. Cold launches a new app process, waits four seconds on the list, locates the proof row, then taps it; stored scoped DTOs remain. App startup time is excluded. No lane builds or tests run during capture; host load is retained per sample.
- A content commit/layout marker replaces the old delayed data-ready marker. A valid HWUI frame has flags zero, ordered DrawStart/FrameCompleted, and DrawStart after the content commit. Missing or incomplete records are never passing samples. Screenshots show resulting content, not a precise painted deadline.

`native-gestures.json` and screenshots retain actual signed-in Android checks: below-threshold cancellation, a scrolling interruption (150 px vertical movement), left reply, right corner prompt/cancel, and long press. Both cancelled cases and the committed reply returned with zero horizontal displacement. No message was sent or corner created. The temporary bookmark was restored to its original unsaved state. No iOS or physical-device timing claim is made.

## Native acceptance revalidation

The selected live-evidence finding is resolved in [native-revalidation.json](native-revalidation.json), with one result per scenario. Scenarios 1/2 reuse the earlier native A/B explicitly accepted by Firstmate; scenarios 3–6 were driven on owned emulator **5634** using candidate `4e4fd5edc2885aecadc7df03d54b43dee1b00e8e`, including the unused swipe-option removal. These are device checks, not mocked recognizers.

- **PASS 1 — Restart, then tap a previously opened Room:** accepted earlier cold p95 **413.065 ms**, down from 916.270 ms; not remeasured in this phase.
- **PASS 2 — Cached reopen with refresh:** accepted earlier warm p95 **331.384 ms**, down from 415.801 ms; not remeasured in this phase.
- **PASS 3 — Scoped cache removal:** the proof Room existed before removal; hot lookup, synchronous restoration and durable read all returned empty afterward. The ordinary opening read then delivered thirty rows. Removed data did not paint before that response.
- **PASS 4 — No tap-prefetch:** a fresh-process deep link completed its own read and displayed native rows. A second check removed the proof Room cache, then navigated without running prefetch: the session reported a cache miss, completed its own read before the first nonempty transcript commit, and displayed native rows without deadlock.
- **PASS 5 — Cancelled gestures:** short swipe and scrolling interruption both returned to **0 px** horizontal displacement without a reply action; the interruption scrolled the selected row **150 px** vertically.
- **PASS 6 — Committed gestures:** reply showed its composer banner and returned to **0 px** after cancellation; corner swipe showed its prompt, cancelled without creating a corner and returned to rest; long press showed message actions, then dismissed. No message was sent.

[Raw device records](native-revalidation-records.json.gz) retain the cache-removal, direct-open and gesture logs; the JSON links nine new native screenshots and records both bundle hashes. SDKs were compiled sequentially with `tsc --noCheck` for this runtime proof; exports used the production origin, runtime override 40 and two workers. Temporary build-only hooks removed only the assigned Room's scoped DTO and bypassed prefetch for the uncached direct-navigation check. They added no permanent control or network site. One export attempt ended with SIGTERM without a build diagnostic; its focused retry succeeded. All temporary source hooks were restored, added device assets removed, and the original production v142 launch asset restored with its SHA256 verified. Auth storage and server data were untouched; no OTA was published.

These behavioral cache-miss checks do **not** measure first-ever uncached tap-to-paint latency. That total remains unmeasured; the exploratory ~377 ms response wait is not a total. **Room-list-return p95 250.815 ms remains OPEN in the PR body.** The Tray experiment stays excluded.

## Recompute and reproduce

Recompute all navigation tables without a device, credentials, or network:

```sh
python3 apps/mobile/evidence/room-open-first-paint/analyze.py --output .beeline-proof/room-open-recomputed.json
```

For a new native capture, first rebuild the four workspace SDKs as described in `docs/agent-mobile.md`. Apply the temporary hooks, export with the installed mobile toolchain, and install only the local launch asset on an emulator you own. Save and restore its original asset. Do not publish an update.

```sh
python3 apps/mobile/evidence/room-open-first-paint/profile.py apply --backup .beeline-proof/room-profile
(cd apps/mobile && NODE_ENV=production EXPO_RUNTIME_OVERRIDE=40 EXPO_PUBLIC_BUZZY_MONOLITH_URL=https://server.usebeeline.app EXPO_PUBLIC_ROOM_OPEN_TRACE=1 EXPO_PUBLIC_LATENCY_RIG_TRACE=1 ./node_modules/.bin/expo export --platform android --source-maps --max-workers 2 --output-dir ../../.beeline-proof/room-export)
ROOM_OPEN_DEVICE=emulator-5634 python3 apps/mobile/evidence/room-open-first-paint/capture.py after --output .beeline-proof/room-recapture
python3 apps/mobile/evidence/room-open-first-paint/profile.py restore --backup .beeline-proof/room-profile
```

Use the same native binary, SDK outputs, hooks and fixture for both arms, alternate their order, and leave other work idle during capture. `profile.py` restores the exact source bytes and must be restored before committing. Native runtime-40 local asset replacement is specific to this proof; it is not a release procedure.

Validation: workspace typechecks, mobile TypeScript, phone network channels (72 sites), UI component policy, cache/prefetch contracts, the 138-test message-variant suite and the 72-test session suite pass. All Vitest runs use at most two workers, one suite at a time. The pipeline supplies final validation and CI.
