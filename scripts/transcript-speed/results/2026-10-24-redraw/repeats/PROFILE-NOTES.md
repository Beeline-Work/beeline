# Scroll profiling and suspected costs

Profiles were collected outside all acceptance timing, after the corresponding full suite. On each APK: start the fixture Hermes sampler, repeat the same slow swipe plus four fast flings three times, stop/dump the sampler. No UI/accessibility dump ran during this gesture sequence. The sampler was disabled before the next acceptance run; reinstalling between APK arms also resets the native probe.

| Sampled stack category | Baseline | Redraw |
| --- | ---: | ---: |
| All samples | 722 | 736 |
| Root-only / idle samples | 302 | 400 |
| Samples with `renderWithHooks` in their stack | 77 | 43 |
| Samples with `propagateParentContextChanges` | 41 | 23 |
| Samples with native `completeRoot` | 86 | 88 |
| Young-generation GC leaf samples | 19 | 19 |
| Samples with deep `equal` in their stack | 0 | 0 |

Counts are sampled stacks, not function invocation counts or milliseconds. They support less React rendering work and similar native tree-commit work during this diagnostic sequence. They do not show an added equality, selector or context-propagation hotspot, and do not establish a frame-time cause by themselves.

Source checks for the proposed suspects:

- `apps/mobile/sources/buzz/room-message-cell.tsx:106`: `React.memo` uses its default shallow prop comparison; no custom deep row comparator was installed.
- `apps/mobile/sources/buzz/room-message-store.ts:705–723`: the deep equality check belongs to the folded projection cache, not a per-frame row comparator. `apps/mobile/sources/app/(app)/beeline/chat/_chat-surface.tsx:1603–1606` memoizes this fold against its input rows, unread boundary and Room/viewer-scoped folder. History/data changes can trigger it; ordinary scroll ticks do not independently trigger a fold.
- `apps/mobile/sources/buzz/room-message-records.ts:199–220`: the existing identity/Room subscriptions are retained. The added code preserves selected-window references; it adds no subscription per row.
- `apps/mobile/sources/app/(app)/beeline/chat/_chat-surface.tsx:6451`: the existing `FlatList`, row keys, render-batch options and window-size options remain unchanged. No `extraData` prop or list-engine swap was introduced.

Raw profiles are `before-repeat-fling-profile.json.gz` and `after-repeat-fling-profile.json.gz`. The complete alternating timing results and full-suite repeat table are in REPEATS.md. No speculative product change was made in response to a noisy point estimate.

The two APKs also contain byte-identical x86_64 Hermes VM, Hermes tooling and React Native libraries; hashes are retained in native-library-comparison.json.
