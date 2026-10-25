# Row-cost attribution

## Result and decision

The measured Android stalls remain. This investigation does not establish an
approved per-row parser, card or hover hotspot large enough to justify a
product change. No parser cache, swipe change, hover rewrite, list-engine change
or native dependency change was made. This is **not** an optimization PASS.

The recommendation is to accept the profiling evidence as step 3's result and
use it to focus the following investigation on React/Fabric tree work. That
requires the commander's decision because the current brief also expects a
measured before/after optimization result. Native commit samples alone do not
prove that replacing the list engine or changing settlement heights will fix
the stalls; those remain separately scoped steps.

## Android Hermes profiles

The complete unprofiled release suite finished before the diagnostic run.
The diagnostic uses the same APK and deterministic fixture, resets traffic and
app data, and exercises fast scroll, older history, two concurrent drafts and
send settlement. All four profiles are separate from acceptance timing.
`symbolicate-row-profiles.mjs` verified both the capture APK hash and the exact
retained local bytecode before resolving the composed source map.

Each cell below counts unique sampled stacks containing that category, once
per sample. Categories overlap and must not be added together. Counts are not
function calls or CPU milliseconds. Root-only samples cannot attribute work.

| Diagnostic scenario | All samples | Root only | React render | Native completeRoot | Legacy Animated | Swipeable | Markdown parsing | Code tokenizer | Card component |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| History | 2321 | 1909 | 208 | 102 | 38 | 2 | 3 | 4 | 0 |
| Send | 280 | 222 | 36 | 13 | 6 | 0 | 0 | 0 | 0 |
| Concurrent streams | 450 | 219 | 98 | 90 | 12 | 0 | 0 | 0 | 0 |
| Fast scroll | 380 | 264 | 63 | 29 | 8 | 1 | 0 | 1 | 0 |

Source attribution of the proposed row candidates:

- Markdown/link parsing: `sources/components/markdown/parseMarkdownBlock.ts:150`
  and `parseMarkdownSpans.ts:8`, reached from ordinary prose rows. Existing
  `MonoMarkdown.tsx:390` already memoizes parsing by markdown and document mode.
  Parsing has only three sampled stacks in history and none in the other
  diagnostic windows.
- Code rows: `sources/buzz/syntax-highlight.ts:300` / `scanLine`, called through
  `tokenizeCode` at line 414 and `CodeHighlighter.tsx:37`. Four history samples
  and one fast-scroll sample do not identify this as the main stalled work.
- Shared ordinary-row swipe wrapper: `RoomMessageVariants.tsx:870` and the
  legacy `react-native-gesture-handler/src/components/Swipeable.tsx:252,299`
  construction path. Legacy Animated lifecycle work appears more often than
  direct Swipeable frames; not every Animated sample can be assigned to a
  particular row or gesture. This does not establish a swipe-specific cause.
  The sibling swipe corner is explicitly waiting for a real reproduction and
  has no replacement implementation to measure on top of. Its swipe code is
  untouched here.
- Card rows: no sampled card-component frame in these windows. A zero sampled
  count is not proof that cards cost nothing or that an unsampled rare stall
  cannot exist.
- Live drafts render plain text through `StreamingProse.tsx:48`; these profiles
  do not show settled markdown parsing on stream ticks.

The dominant attributed stacks instead pass through React Fabric's
`ReactFabric-prod.js:9378` / `workLoopSync`, its render path at line 9359,
and native `completeRoot` from the mutation commit at line 8102. Native work
cannot be assigned to a particular row type from the Hermes stack alone.

The profile is a bounded diagnostic, not a negative proof about every future
transcript. It supports declining speculative caches; it does not support
claiming the user-visible stalls have been fixed.

## Native sampling cross-check

An additional separate diagnostic recorded the actual release process during
two concurrent streams with the emulator's `simpleperf`:

```sh
simpleperf record -e cpu-clock -f 250 -g --duration 8 -p <fixture-pid> \
  -o /data/local/tmp/rows-native.data
simpleperf report -i /data/local/tmp/rows-native.data --children -n \
  --sort comm,symbol --percent-limit 0.5
```

Before recording, open the streaming corner and run one unmeasured stream to
establish the newest reading position, as in the Android capture driver. Start
recording, wait 500 ms, then run the same `fixtureStimulus().stream()` again.
The record contains 1870 samples and reports zero lost samples. Sampling was
disabled before subsequent unprofiled hover controls.

On the JS executor, `ShadowTree::tryCommit` accounts for 15.83% of **all-process
sampled CPU weight**, including its descendants; `ShadowTree::mount` 6.47% and
`YogaLayoutableShadowNode::layoutTree` 4.71%. These nested percentages overlap.
Their installed React Native source locations are
`ReactCommon/react/renderer/mounting/ShadowTree.cpp:284,384` and
`ReactCommon/react/renderer/components/view/YogaLayoutableShadowNode.cpp:590`.
Unistyles registry linking is 0.75% in the same report. The emulator RenderThread
also has substantial graphics-pipe work; this is a shared-host software-GPU
diagnostic, not a physical-phone verdict or proof of a product cause.

[Raw native recording and report](native-profile/manifest.json) and
[raw/symbolicated Hermes profiles](android-profile/manifest.json) are retained.
The manifest hashes each uncompressed artifact. The native report resolves
exported symbols but not every private function; unknown addresses are retained.

## Warmed packaged hover control

The first packaged capture was slower than Chrome. To test attribution, six
fresh sessions alternate enter/leave transitions and steady movement within one
visible row: transitions, steady, steady, transitions, transitions, steady.
Each arm resets scenario traffic, uses the same package and binary, warms the
initial pointer, and dispatches thirty real pointer moves. Every arm is retained.

| Arm | Path | Worst JS gap (ms) | Missed JS opportunities | JS interval p95 (ms) | Pointer to second rAF p95 (ms) |
| --- | --- | ---: | ---: | ---: | ---: |
| 1 | Enter/leave | 21 | 0 | 19 | 31 |
| 2 | Steady | 22 | 0 | 17 | 30 |
| 3 | Steady | 20 | 0 | 17 | 29 |
| 4 | Enter/leave | 56 | 2 | 20 | 36 |
| 5 | Enter/leave | 21 | 0 | 20 | 33 |
| 6 | Steady | 23 | 0 | 19 | 32 |

Median worst gap is 21 ms for enter/leave and 22 ms for steady movement;
median missed opportunities is zero in both. Enter/leave p95 is modestly
higher, and one enter/leave arm has an isolated long gap. These controls do not
reproduce the earlier sustained packaged slowdown or establish a large
hover-specific cause. The Chrome trace shows `DesktopMessageAction.tsx:9`
rendering and `RoomMessageVariants.tsx:808,904` hover handling, but provides no
missing large CPU hotspot. No hover implementation change is justified from
this combined evidence.

[Complete alternating control captures, host snapshots and screenshots](packaged-control/manifest.json)
are separate from the initial unwarmed packaged trials. Do not pool them.
The control captures' generic `note` still says three trials; that boilerplate
predates the repeat-count option. Each control file's explicit `repeatCount: 1`
and single sample are authoritative. The raw files remain unedited; the driver
now uses count-independent wording.
