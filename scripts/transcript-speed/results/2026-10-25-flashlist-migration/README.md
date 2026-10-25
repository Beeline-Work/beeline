# Android FlashList migration: hold shipping

Do not ship this migration. Recommend retaining the current Android FlatList until history layout work is profiled and corrected. The brief instructs stopping for a decision when tuning leaves a pacing regression. The experiment is retained for review in a draft pull request. The failed ship gate remains unresolved; this is not ready to merge or release. The archived report records the earlier pre-PR measurement decision.

## Result

The initial FlashList release APK improved warm Room first-frame median (215 ms versus 455 ms). It passed all captured correctness blocks (three). Main clipped one concurrent stream in its second block; the failed screenshot, OCR, partial capture and process failure are retained. The remaining main blocks passed those captured paths.

The first-frame metric is the existing release `newest-frame` log marker after the launch intent. This is not physical scanout. Every quiet-settling measurement was unavailable; it must not be substituted for the earlier benchmark's settled-open metric. Tuned warm opens were not measured after the stopping condition below.

Initial matched-path JS interval p95 median was (25.46 ms) for FlashList and (22.53 ms) for main. Only paths present in every capture contribute to this comparison; streaming and send timing are excluded from both sides because main's failed block ended early.

## Narrow tuning and fresh comparison

Tuning reduced FlashList draw distance to (100 dp) and stabilized the message-key callback so unrelated parent renders do not replace it. The installed FlashList version is (2.3.2); its automatic layout measurement was retained. Unsupported legacy estimated-size props were not introduced.

Fresh alternating main/tuned release APK pairs repeated the unchanged scroll, fling, older-history and incoming-message harness paths (three pairs). Compilers and tests were stopped during captures. This focused rerun establishes the stopping decision; it does not establish that every tuned correctness or release gate passed.

JS interval p95 in milliseconds: median; observed repeat range.

| Path | Main | Tuned FlashList |
| --- | ---: | ---: |
| scroll | (47.73; 21.07–48.24) | (33.90; 27.84–35.65) |
| fling | (46.92; 40.13–53.42) | (39.35; 33.38–43.37) |
| history-prepend | (23.28; 22.03–29.24) | (31.76; 28.24–36.89) |
| incoming | (17.86; 17.50–22.11) | (17.71; 17.40–18.65) |

History paired differences were (13.61 / -1.00 / 9.72 ms), with median (9.72 ms) slower for FlashList. Main's history repeat spread was (7.20 ms). History was slower in most pairs (two of three). The candidate and baseline ranges overlap: this is a noisy emulator comparison, not a confidence interval. The paired median penalty exceeds the observed main repeat spread, so the strict no-regression gate is not accepted.

HWUI jank percentages: median; observed repeat range. These are separate from JS animation-frame intervals.

| Path | Main | Tuned FlashList |
| --- | ---: | ---: |
| scroll | (15.38; 4.65–16.67) | (7.26; 6.72–10.32) |
| fling | (11.32; 9.02–14.84) | (8.20; 1.89–10.96) |
| history-prepend | (5.03; 4.60–7.65) | (4.14; 1.17–4.30) |
| incoming | (10.00; 5.00–14.29) | (10.53; 10.53–15.79) |

HWUI history janky/rendered counts in paired order: main (25/497; 39/510; 23/500); tuned (23/535; 5/428; 18/435). Native history jank improved; that does not erase the JS interval regression.

## What was implemented and verified

Android alone resolves the transcript wrapper to FlashList; web retains the existing DOM renderer and iOS retains FlatList. The adapter preserves inverted controller coordinates and visible-position following, omits FlatList-only tuning/failure props, resolves Unistyles before third-party layout reads, and acknowledges each message layout. A keyed message subtree resets local state when a recycler slot changes message identity. No dependency, runtime pin, swipe implementation or release pipeline was changed.

Root typecheck passed after tuning. Focused tests passed (60 tests), including keyed recycling state isolation and preservation of local state across updates to the same streaming message. Those use a simulated recycler slot; they are not a device proof of every real row interaction. The dead-code gate passed before tuning (four existing findings, zero introduced).

The initial release captures demonstrated older history loading, incoming visibility, warm switches, both stream labels, and server-settled sends. Older history becoming visible does not prove pixel anchoring. Pixel-identical light/dark screenshots, exhaustive real swipe/expansion/attachment/draft recycling, and full keyboard/anchor audits are not established. The brief's performance stopping condition was reached before accepting those remaining ship gates.

## Reproduction and provenance

Not a defect report. Performance stand-in: the approved list-engine benchmark harness and deterministic transcript fixture on the Android release app. Both APKs used the same continuously running API (35) x86 emulator, Hermes/Fabric, local proxy RTT (100 ms), jitter (zero), and bandwidth (10 Mbps). This shared-host SwiftShader emulator is not a physical-device calibration.

Baseline commit: `174162f49ad69f441f03b6a92d6b4e7da312eacd`. Original and tuned source snapshots, hashes, APK hashes, captures, visible-stream screenshots, OCR, validation logs and orchestration outcomes are in `evidence.zip`. APK binaries are not in the archive. Original instrumentation has a working-directory-sensitive diff stamp; independent saved sources and explicit APK hash checks are the provenance used here. The capture file's legacy `partial` label also appears on successful exits; driver exit records and complete path data distinguish completed runs from the retained failed main run.

Use `analysis.json` for all raw per-repeat figures. To repeat, restore the archived source snapshot, use the existing local fixture/build instructions with an isolated database and leased emulator, and run the archived warm/open and scenario drivers against the explicit matching APK. Local proof paths and driver commands are preserved in the archive; they are not production services.

## Decision requested

Retain FlatList and close this migration attempt, or authorize a separate focused profile of FlashList history layout before another engine migration. Recommend retaining FlatList for now.
