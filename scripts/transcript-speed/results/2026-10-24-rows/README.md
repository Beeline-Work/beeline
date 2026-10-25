# Cheaper-row investigation

Step 3 starts from `4b8f8feffeef308bbdb56c0007f36e5454623277`, which includes
the merged baseline and redraw work. The profiling phase is complete. The
[full Android baseline](ANDROID-BASELINE.md) and [attribution and recommendation](PROFILE-NOTES.md)
are retained. No product optimization or passing before/after optimization gate
is claimed; a profiling-only result needs the commander's decision.

## Chrome hover

The existing production web export, deterministic transcript fixture and real
pointer input exercise narrow web (390 × 844) and desktop web (1280 × 844).
Each trial moves between visible message rows and outside the transcript.
Thirty moves per trial, three trials per width. A long answer fills the narrow
viewport, so that arm alternates its one visible row with the outside margin.
The two corner-owned native builds were frozen throughout these captures and
resumed afterward. Unrelated shared-host work cannot be excluded.

| Width | Trial | Worst JS gap (ms) | Missed JS opportunities | JS interval p95 (ms) | Row commits | Pointer to second rAF p95 (ms) |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Narrow | 1 | 16.80 | 0 | 16.70 | 0 | 18.10 |
| Narrow | 2 | 16.80 | 0 | 16.80 | 0 | 16.70 |
| Narrow | 3 | 16.80 | 0 | 16.70 | 0 | 19.50 |
| Desktop | 1 | 16.80 | 0 | 16.80 | 0 | 17.60 |
| Desktop | 2 | 16.80 | 0 | 16.70 | 0 | 18.70 |
| Desktop | 3 | 16.80 | 0 | 16.70 | 0 | 18.00 |

These are all trials, not selected favorable values. Row commits count the
existing `RoomMessageCell` probe; zero does not mean its internally stateful
children never rendered. Pointer-to-second-rAF is a browser rendering upper
bound, not physical scanout. Separate Android UI frame statistics do not apply
to Chrome.

Separate diagnostic runs retain Chrome timeline traces and CPU sampling
profiles with source positions resolved against the exact exported source maps.
Nearest-product sampled stacks in the desktop run rank
`DesktopMessageAction.tsx:9` (23 samples),
`RoomMessageVariants.tsx:808` / `SwipeToReply` (5), and its
`onMouseLeave` at `RoomMessageVariants.tsx:904` (1). These counts are sampled
stacks, not invocation counts or additive CPU milliseconds. The narrow run
has no sampled product hover frame; its layout does not mount desktop actions.

The desktop trace confirms that local hover state renders the shared action
components. The unprofiled trials show no missed JS opportunities or long
stalls, so this evidence does **not** justify changing hover implementation.
Packaged Tauri measurements are retained separately below; Chrome is not a
substitute for the packaged application.

Raw captures, source-mapped profiles, timeline traces, screenshots and bundle
hashes are under [web-hover](web-hover/manifest.json). The manifest hashes JSON
before gzip compression, and hashes screenshots directly. Reproduce with
`capture-hover.mjs` as described in the harness README. This is performance
investigation, not a new defect report.

## Packaged hover

The extracted Debian package runs the same frontend in an isolated Tauri
identifier and XDG directories, with real WebDriver pointer input on its own
Xvfb display. Both native builds had finished before this capture. The driver
verified trusted pointer events and visible hovered actions, and saved the
actual packaged screenshot. Viewport: 1280 × 840.

| Trial | Worst JS gap (ms) | Missed JS opportunities | JS interval p95 (ms) | Row commits | Pointer to second rAF p95 (ms) |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 125 | 24 | 29 | 0 | 55 |
| 2 | 53 | 15 | 27 | 0 | 53 |
| 3 | 51 | 26 | 34 | 0 | 66 |

These packaged results are slower than Chrome. They do not isolate React hover
state from WebKit input, rendering or shared-host scheduling. A separate steady
pointer control is needed before attributing the difference to row hover work.
WebKit does not expose a Chrome trace; the Chrome shared-code diagnosis and
these packaged timing results are distinct evidence. The driver now supports
`TRANSCRIPT_HOVER_STEADY=1` for that diagnostic control. These initial trials
predate the driver's explicit pointer warmup; do not pool them with warmed
trials.

[Package/binary hashes, complete samples and screenshot](packaged-hover/manifest.json)
remain available for inspection.
