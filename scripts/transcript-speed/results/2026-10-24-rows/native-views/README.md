# Native row views

Ruby accepted the profiling finding and continued the assignment with native
view counts. Parser caches, hover rewrites and swipe changes remain excluded.
This is a performance investigation, not a defect report.

## Reproduction native-row-views

Build the existing local release fixture with the opt-in native probe. Open
Transcript B with six diagnostic messages after its deterministic history:
plain text with a byline, a continued plain message, a heading and two
paragraphs, plain text with an attachment, an agent corner-proposal card, and a
system line. Their identifiers are SHA-256 of
`transcript-speed-v1:native-row-count:<kind>`, with kinds in `count_views.py`.
The diagnostic messages are only for counting and screenshots; reset them
before timing the original fixture scenarios.

Broadcast the probe's `views` action and pull `latency-views.json`. This walks
the actual Android View tree in the release app, including native SVG nodes.
It does not count React elements or accessibility nodes. Existing identifiers
bound the rows; the probe adds no identifiers or non-collapsible row props.
Run `python3 count_views.py <tree.json.gz>` to reproduce the counts.

## Mounted counts

Content includes the existing long-press surface. Cell totals additionally
include the list cell, the untouched swipe shell and any day caption. SVG
shape/group nodes are Android Views, but do not each represent a Yoga layout
node. The ungrouped header count includes this fixture identity's avatar;
different faces have different SVG shapes.

| Row | Content before | Content after | Cell before | Cell after |
| --- | ---: | ---: | ---: | ---: |
| Plain, ungrouped | (31) | (30) | (45) | (44) |
| Plain, grouped | (4) | (3) | (17) | (16) |
| Markdown, heading and two paragraphs | (6) | (6) | (19) | (19) |
| Attachment with plain caption | (9) | (8) | (22) | (21) |
| Corner proposal card | (40) | (40) | (53) | (53) |
| System line | (5) | (5) | (6) | (6) |

The ungrouped avatar/byline contributes (27) mounted Views, unchanged. A grouped
message contributes no repeated header (0). `counts.json` also separates
React View/Text classes from native SVG classes. Counts depend on content:
the original fixture's long markdown message has more paragraph Text nodes
than the compact diagnostic markdown row.

## Count-supported change

`MonoMarkdown.tsx` gave every paragraph group a root View identifier. Fabric's
`ViewShadowNode.cpp:71` materializes a View when `testId` is nonempty, even
when its styles alone could flatten. For a single text paragraph, move that
identifier to the already necessary Text. Retain the exact Yoga wrapper and
styles. The native root disappears; multiline markdown, cards, system lines,
headers, parsers and swipe behavior are unchanged.

An initial direct-Text variant also removed a node, but changed Android pixel
rounding at fractional row positions. It was rejected before acceptance
timing. Keeping the Yoga wrapper avoids that shift while removing the native
View. Its failed screenshots are retained separately.

## Demonstrated native-row-views

The built candidate produces the counts above. Android light and dark compare
with zero changed product pixels; the comparison excludes only the dynamic
system status bar at the top (100 physical pixels). Full, unmodified
screenshots and raw native trees are retained. Desktop web captures use a
fixed Date for both arms to avoid the midnight date-prefix change.

Desktop web also has zero changed pixels across each full screenshot in both
themes. The [comparison data](pixel-comparison.json) keeps full Android status
bar differences separate from product pixels.

## Timing result and remaining gate

[Every alternating trial](TIMINGS.md) includes JS p50/p95, worst gap, missed
opportunities, Android UI p95, row commits and native commit/layout/mount
p50/p95. Native marker phase durations have millisecond precision and overlap;
they are not additive CPU times. JS p50/p95 means the existing JS frame-interval
metric, not executor busy CPU.

History median missed opportunities improve (368 to 327), UI p95 improves
(93 to 81 ms) and row commits stay (110). Its median worst JS gap is worse
(461.88 to 552.12 ms), so a worst-stall improvement is not claimed. Send and
fling improve on both JS measures, UI p95 and row commits.

Concurrent streams improve median worst gap (446.59 to 329.17 ms), missed
opportunities (202 to 167) and UI p95 (81 to 61 ms), but total row commits
increase (20 to 23). Each active stream row commits (4) times in every arm:
active-stream commits total (8) in all six trials. Historical-row commits are
before (10, 13, 9), after (13, 13, 14); live-status commits are before
(2, 2, 2), after (2, 2, 3). This locates the count conflict around the drafts,
but does not establish why the historical rows mounted differently.

Slow scroll commits no rows in either arm (0), yet its median worst gap,
missed opportunities and UI p95 are worse. The full spreads overlap; these
three trials do not prove equivalence or establish a cause. Keep that result
alongside the wins. No blanket no-regression gate or finished optimization
assignment is claimed. The draft needs the commander's decision on these
conflicts before review readiness.

## Validation and provenance

The final root typecheck and dead-code gate pass. The focused markdown,
ledger and row suite passes (220 tests). The full mobile run has (613 passing
files, 5 skipped, 1 failing; 5412 passing tests, 6 skipped, 1 failing). The
only failure remains the native fingerprint end-to-end test, already
[reproduced on the clean base](../CHECKS.md). It is not repaired here.

APKs use the same local Hermes release build path, x86_64 emulator, fixture
fingerprint and private control route. Each timed arm reinstalls its exact
APK, resets generated traffic and keeps Hermes sampling off. Fabric marker
recording is enabled in both arms. Builds and tests finish before captures;
unrelated shared-host noise cannot be excluded. The first before arm predates
per-arm host snapshots; its raw measurements are retained unchanged.

The first final web export reused a shared Metro transform containing another
local backend port. Its CORS failure was not a product rendering result.
The successful final export uses a private TMPDIR and `--clear`, with its
embedded fixture URL verified before screenshots. No runtime, native
dependency, release pipeline, swipe or hover implementation changes are made.
