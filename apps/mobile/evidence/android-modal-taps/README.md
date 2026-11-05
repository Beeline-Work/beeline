# Android modal work and hardware-GPU timings

Closed Android modals were deep-walking their unused child presentations on every host update. `HullDialog.tsx` now excludes those children from the existing reconciler while keeping outer callbacks stable. Visible surfaces and iOS dismissal retain their existing behavior. No cache, native change, animation change, or network site was added.

**The 150 ms interaction and 450 ms Room-load goals remain open.** This change removes measured JS work; these samples do not establish an end-to-end latency improvement.

## Device and provenance

The same Play **144** universal APK (versionName **0.2.24**, runtime **44**) ran on an Android 35 x86_64 emulator: four cores, 2048 MB, 1080×2400 at 420 dpi, macOS 26.5.1, emulator 37.3.6, `-gpu host`. SurfaceFlinger reports **Intel Iris Plus Graphics OpenGL Engine**; HWUI uses `skiagl`. These are hardware-GPU emulator measurements, not physical-phone measurements. The earlier GPU-less Linux/SwiftShader results are excluded.

Production had advanced to **v0.1.159**, source `a99f410cd91e7a17a63cd27a0340a9ad465137c9`. First, the unmodified production OTA was captured. The before/after profiling bundles then used that mobile source, the same SDK module bytes, the same native binary and temporary hooks. Their source maps differ only in `HullDialog.tsx`; [provenance.json](provenance.json) records bundle/APK hashes and the shared-source fingerprint. Neither bundle was published.

Only the Beeline Review Workspace and its one-member proof Room were opened. There were five consecutive process-cold launches per arm, followed by five sheet openings in the last process. The first sheet opening mounts its native dialog; later openings reuse the process. Arms ran consecutively, with host load retained per sample. Live fixture and host variation limit causal timing conclusions.

## Sheet results

Milliseconds, median / max, **five samples** per cell:

| Measure | Before | After |
| --- | ---: | ---: |
| Hidden presentation reconciliation | 2.814 / 10.628 | **0.538 / 0.904** |
| Sheet content commit | 112.551 / 221.828 | 148.732 / 181.791 |
| Native-frame proxy | 295.352 / 438.067 | 295.479 / 427.528 |

Uninstrumented production's native-frame proxy was **253.955 / 342.619 ms**. The profiled arms show less hidden reconciliation, but essentially unchanged native-frame median. Do not claim that this change meets 150 ms.

The native-frame proxy is the first completed app HWUI frame whose DrawStart follows both the sheet content commit and its new native-window relayout. It is not compositor scanout or an optical content-paint measurement. Complete first-draw frames with `WindowVisibilityChanged` are included; skipped frames and incomplete timestamps are rejected. These flag meanings come from [Android 15 FrameInfo.h](https://android.googlesource.com/platform/frameworks/base/+/refs/heads/android15-release/libs/hwui/FrameInfo.h).

## Cold-start breakdown

Milliseconds, median / max, **five samples** per arm. Absolute launch offsets use the device uptime immediately before `am start`; font loading is a duration. Activity first draw can include the native splash.

| Measure | Before | After |
| --- | ---: | ---: |
| Activity first draw | 3567 / 6267 | 4180 / 4413 |
| Root module evaluated | 3132.601 / 5534.269 | 3628.142 / 3892.403 |
| Font load duration | 278.923 / 450.984 | 300.358 / 363.127 |
| Splash hide requested | 3623.889 / 6282.760 | 4226.208 / 4472.767 |
| Room-list data commit | 4469.070 / 7843.788 | 4961.195 / 5534.637 |
| Following list native-frame proxy | 4756.171 / 8203.111 | 5453.604 / 6106.871 |
| First Room tap → data commit | 347.648 / 407.641 | 399.040 / 708.958 |
| Following Room native-frame proxy | 677.679 / 824.927 | 864.108 / 1100.859 |

These diagnostic Room-frame proxies do not certify the first visible message. Unmodified production Activity first draw was **3794 / 3825 ms**. Root-module and native startup work precede this change's conditional execution; the cold-start variation is not evidence of a causal startup improvement or regression from this patch.

## Behavior and verification

The native rename editor and keyboard opened; Cancel made no Room change. Repository options opened, cancelled, and reopened collapsed. Hardware Back dismissed the sheet. [Before](sheet-before.png) and [after](sheet-after.png) screenshots have identical sheet text/bounds and identical pixels in the sheet-body region `(0,1370)–(1080,2328)`.

The colocated `HullDialog.test.tsx` reproduces hidden-content reads before the fix and verifies no hidden wrapper rerender, fresh callbacks, updated content on reopen, and retained iOS dismissal reconciliation. Fourteen focused mobile tests, root typecheck, UI component policy, and the 72-site phone-network inventory pass. Temporary hooks were removed from product source.

Recompute every table from the sanitized logs, HWUI records, and extracted Perfetto timing slices without a device, network, or credentials:

```sh
python3 apps/mobile/evidence/android-modal-taps/analyze.py --output .beeline-proof/modal-measurements.json
```

[measurements.json](measurements.json) contains individual samples. Full native traces and the reusable Mac setup remain in the private task evidence; no session credential is included here.
