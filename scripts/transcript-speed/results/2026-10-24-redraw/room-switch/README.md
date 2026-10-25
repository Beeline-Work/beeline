# Room-switch transition acceptance

Reproduction `TRANSCRIPT-REDRAW-2`. The latest commander-approved Room-switch gate and the retained additional transition proof are below. The acceptance rule was supplied by the commander, not changed by the implementer.

## Latest approved Room-switch rule

Ruby approved this supplemented rule after reviewing the p95 reversal: Room switching passes only if the worst JS stall is lower, missed JS frame opportunities are lower, Android UI p95 is no worse, and transcript row commits are lower. JS interval p95 stays reported but does not gate Room switching. Frame p95 remains the gate for incoming, typing, send, concurrent replies and fast scroll. No further p95 captures were taken for this decision.

The same complete before/after suite retained in `repeats/recheck-full-*.json.gz` passes all four conditions. Each cell below is median per-trial value followed by the full min–max spread. These are the existing three repeats per arm on the same Android instance and APKs.

| Room-switch measure | Before | After |
| --- | ---: | ---: |
| Worst JS stall per trial, ms | 2638.11 (2517.91–3095.84) | 664.81 (491.73–997.18) |
| Missed JS frame opportunities per trial | 1265.00 (1231.00–1303.00) | 964.00 (823.00–1041.00) |
| Android UI p95 per trial, ms | 150.00 (133.00–150.00) | 133.00 (133.00–150.00) |
| Transcript row commits per trial | 1620.00 (1592.00–1712.00) | 1142.00 (1141.00–1142.00) |
| JS interval p95, reported only, ms | 19.55 (19.27–19.78) | 110.46 (29.15–158.83) |

P95 reverses because a multi-second gap contributes only one interval. Baseline has too few long intervals to reach the five-percent cutoff, so its p95 looks good while most wall time is spent stalled. Worst stall and missed opportunities expose that cost. The first matched suite also improved Room-switch JS p95 (204 → 79 ms); both results remain retained.

**Worst Room-switch stalls of about 0.5–1.0 seconds remain after this fix. Step 5 (Room open) owns reducing those stalls.** This PR reduces redraw propagation and does not claim Room opening is fully solved. The real-tap settling proof below remains additional evidence; it is not a replacement for this latest approved gate.

## Additional real-tap transition proof: PASS

Six warm Room-list taps per arm, alternating Transcript A/B. Each tap has a native transcript frame-commit marker and the required 500 ms period without a JS frame over 50 ms. Each table cell is the median followed by complete min–max spread in milliseconds.

| Approved transition metric | Before | After |
| --- | ---: | ---: |
| Time to settled, including quiet confirmation | 1925.02 (1209.48–2146.60) | 988.95 (977.89–1093.10) |
| Total JS busy CPU time inside that window | 1017.06 (741.87–1069.20) | 532.36 (509.87–600.43) |
| Per-transition worst JS gap | 234.00 (216.24–281.09) | 181.66 (171.11–225.78) |

The maximum gap across all six tap transitions also improves (281.09 → 225.78 ms). The earlier full-suite median maximum-gap result remains retained separately (2638 → 665 ms); these real-tap trials are not pooled with it.

After worst-case trial settling and busy CPU time are both below the best baseline trial. Median after upper alignment bound is below median before lower alignment bound. No trial was omitted.

## Same emulator, fixture and APKs

The still-running corner-owned Android 15 instance is `127.0.0.1:5555`, the exact process used by the preceding complete suite. Private ADB server port is 5950; private capture control is 19906, reverse-mapped from the APK’s 19886 endpoint. Same fixture fingerprint and identical release APK hashes: before `f72b96ba2bee56395291cafab5c3eb9e4ebe6e2464261d4e77746ba04cfb0eba`, after `061be2300d89505768aaf618ecdcd2fc2b886ac0af7d06551bd6b3da5f832b91`. React Compiler remains disabled. No product code or APK was changed for this proof.

Both arms reinstall the selected app, reset generated fixture traffic and sign in with the local review route. Each adds the same deterministic native-probe marker message to each Room. The original seeded messages and fingerprint remain unchanged. These marker IDs and text are scenario traffic retained in capture metadata; they allow the native probe to prove the target transcript’s drawn frame, rather than merely a route transition. Both Rooms are warmed outside timing. The driver selects the fixture Workspace and taps the real Room-list label. It does not measure an `am start` deep link as the user action.

## Timing and CPU method

The unchanged release measurement runtime records rAF intervals. The shell-only native fixture probe records ACTION_UP and hardware frame commitment containing the target message. JS `ROOM_OPEN` timestamps and native log epochs align those clocks; per-trial alignment spread is retained. The collector waits from the native paint until a complete 500 ms period with no rAF interval above 50 ms. A long interval crossing the quiet deadline restarts confirmation; it cannot be hidden by placing its endpoint later.

Total JS busy time is the JS executor thread (`mqt_v_js`) CPU runtime from `/proc/<pid>/task/<tid>/schedstat` inside that same window. It includes scheduled execution, not scheduler wait or idle frame time. A persistent shell observer samples the counter approximately every 20–30 ms. CPU boundary samples, scheduler wait, interpolation and bounds are retained. This measures CPU consumed by JS execution and its synchronous native calls on that thread; it does not measure other native threads.

The old APK omits its first rAF timestamp. Rather than invent an exact one or rebuild either APK, the analyzer bounds its placement by the sample duration left after summing all intervals (16.7–33.4 ms here). The table uses the midpoint, with earliest/latest settling and CPU bounds retained. CPU bounds include those frame-placement extremes. JS/native log-clock alignment spread is separately retained (at most 6.93 ms before, 0.99 ms after). These errors are much smaller than the observed improvement.

Two setup attempts ended before any timed trial: the measurement runtime must first be loaded by opening a transcript, and unread Room labels append a suffix to their accessibility description. The final collector opens the runtime before readiness and taps the exact visible Room label. No acceptance trials came from either setup attempt.

No builds, tests, screenshots, accessibility dumps or profiler ran inside acceptance windows. Native logs and UI checks are read after each completed window. Counter-observer overhead is common to both arms but not separately quantified. These are shared-host emulator measurements, not physical-phone latency.

## Separate after Hermes profile

The profiler was enabled only for one additional after Room-list switch, after all acceptance trials. The matching local bytecode hash was verified against the after APK before symbolication. Bytecode SHA-256: `9aa28d2671d53597e041f88ecefe5ad6ae0f6020818b66e028c4d853ba33685c`; composed source-map SHA-256: `8110871cf3f6c6507e2b21a1b29ba09ce7f3c359bde89afcb5378a427bd772f4`. The source map and bytecode remain local build outputs; raw and symbolicated stacks are retained here.

The separately profiled switch had frame gaps (90.97, 101.80, 50.10 and 70.83 ms) in the requested 30–160 ms range. Hermes sampled 27 stacks in those windows. Frame-to-profile placement has the retained 33.27 ms first-rAF uncertainty. These are sampled stack counts, not invocation counts, per-function durations or additive CPU totals.

| Observed work in those frames | Sampled stacks | Source location |
| --- | ---: | --- |
| Synchronous React/Fabric rendering and reconciliation | 20 / 27 | `react-native/Libraries/Renderer/implementations/ReactFabric-prod.js:9497` (`performUnitOfWork`), `:9378` (`workLoopSync`) |
| Function component rendering | 11 / 27 | `ReactFabric-prod.js:3636` (`renderWithHooks`) |
| Layout effects and fresh SVG group construction | 3 each | `ReactFabric-prod.js:7812`; `react-native-svg/src/elements/G.tsx:20` |
| Native style/ref linkage | 2 | `react-native-unistyles/src/specs/ShadowRegistry/index.ts:62` |
| Floating presentation reconciliation | 1 nearest product stack | `apps/mobile/sources/components/buzz/HullDialog.tsx:195` and `:198` |
| Row mention-handle projection | 1 nearest product stack | `apps/mobile/sources/app/(app)/beeline/chat/RoomMessageVariants.tsx:1332` |
| Cached surface lookup/fetch and app configuration lookup | 1 each nearest product stack | `apps/mobile/sources/buzz/surface-registry.ts:36`, `:173`; `apps/mobile/sources/sync/appConfig.ts:30` |

The dominant observed work is mounting/rendering the Room subtree and committing its effects, rather than a sampled deep row equality hotspot. The sparse product frames do not establish a dominant cheap fix inside the redraw scope. No speculative product change was made. For step 5 (Room open), investigate retaining reusable Room subtrees, reducing freshly mounted SVG/style work, avoiding unnecessary floating-presentation reconstruction on navigation, and coalescing config/cache setup. Profile these candidates before changing them; the single samples above do not prove those individual calls are material bottlenecks. Any reuse must preserve Room/viewer callback scope and canonical server state.

## Reproduction and validation

[Before capture](before.json.gz), [after capture](after.json.gz), [profile summary](profile-summary.json), [raw profile](profile.json.gz), [symbolicated profile](profile-symbolicated.json.gz), [profile frame sample](profile-frames.json.gz), and [exact wrapper](run.sh). The retained logs show native paint markers and Room-open clock alignment. The root capture driver and metric analyzer are under `scripts/transcript-speed/`.

The transition analyzer tests cover paint-before-quiet ordering, long gaps crossing confirmation, CPU coverage and timing uncertainty. All seven harness/transition tests pass. Product edits, reactions, streaming tails, keyboard docking and reading position were already demonstrated on this exact after APK in the original evidence; no new product change invalidates that proof. CI must pass on the evidence commit before the PR is marked ready.
