# Unified failure surfaces

The approved error-surface board is implemented with `IndexRow` for page/list/media failures, `ErrorBanner inline` for contextual feedback, and `EmptyState` for true absence. Row-scoped settings failures keep their shared row descriptions. Existing callbacks, permissions and recovery controls are retained; passive media failures gain no Retry control. Runtime recovery stays provider-free.

- [Approved design board](https://prefers-processed-radar-buck.trycloudflare.com/)
- [Original → implementation comparison](https://uncertainty-generally-life-processes.trycloudflare.com/)
- [Acceptance measurements and source hashes](acceptance.json)

The comparison contains 133 source-bound regions plus an inventory of 42 shared-dialog call sites. It preserves the approved snapshot and renders the implementation separately. Data, callbacks, connection state and native services are fixture values; these are React Native Web region proofs, not authenticated whole-app or physical-device captures. Both public boards returned HTTP 200 when delivered.

## Acceptance

The implementation rendered all 133 regions in Bone and Obsidian at 360px and 1200px: 532 frames, zero rendering errors, and no changes to approved region control counts. The Room failure has 20px left/right margins, the existing recovery copy, and “History unavailable” in sentence case in all four cases. The shared `IndexRow` owns typography, divider and Retry treatment.

| Surface | Bone phone | Obsidian phone | Bone desktop | Obsidian desktop |
| --- | --- | --- | --- | --- |
| Room history | [360px](room-bone-360.png) | [360px](room-obsidian-360.png) | [1200px](room-bone-1200.png) | [1200px](room-obsidian-1200.png) |
| Image failure | [360px](image-bone-360.png) | [360px](image-obsidian-360.png) | [1200px](image-bone-1200.png) | [1200px](image-obsidian-1200.png) |

Saved-content connection coverage also renders the real Room-list and Room fixtures in connected, connecting and disconnected states: [Bone](connection-bone.png), [Obsidian](connection-obsidian.png).

## Retired anatomy

Removed `NetworkUnavailableState`, `RoomDeckUnavailableView`, `PinnedConversationsEmpty` and `NoMatchingConversationsEmpty` from the active library and its registry. Their callers compose the shared primitives directly. Removed the framed `ErrorBanner` variant and the local message-search Retry adapter. Connection status, transcript paging failures, media placeholders, tool-output load failures and local error text now use the shared grammar. Snapshot/Markdown preview failures show a passive explanation instead of retaining the loading glyph. Loading indicators, byte/render owners and existing viewer actions remain responsible for their original behavior.

## Regression coverage

Root typecheck, UI component policy, the phone-network inventory, dead-code analysis (zero introduced findings), its 29 scanner tests, and the 115-test policy/design/browser batch pass. The 15 affected suites that initially failed on retired selectors/treatments were rechecked successfully. Media and sandbox coverage passed 110 tests; the added preview-failure/recovery cases passed in the policy batch. Tool-output coverage passed 43 tests, including rejected/missing output, unchanged Copy behavior and clearing feedback on the next open.

The full mobile run used `--maxWorkers=2`: 665 files passed, 11 skipped, 17 failed initially. Migration-related failures were corrected and rerun. Eight remaining dependency tests—six LiveKit cancellation/timeout cases and two icon-font web-failure cases—also fail with untouched baseline test inputs and no changed UI loaded. That reproduction has the same two `Event is not defined` rejections. [Baseline input hashes and result](baseline-dependencies.json) record the comparison; the local dependency generation is not changed by this UI task.

## Captured evidence

The board and saved images preserve the approved implementation evidence. Main subsequently retired the source-scanning/browser-proof harness and its audit modules; this merge keeps those deletions. Focused unit cases beside the product retain failure/recovery and passive workspace-identity coverage.

## Room-list header follow-up

The unavailable Room list now uses the loaded header’s shared workspace identity and header style: 62px height, 20px leading inset, 34px workspace plate, and body-strong title. The passive identity has no caret or press target; Reconnect remains the only failure action. Desktop follows the loaded content-pane header, with workspace navigation owned by the rail.

[Live comparison board](https://uncertainty-generally-life-processes.trycloudflare.com/header-comparison.html) shows real-code before, loaded-reference and after frames in both themes at 360px and 1200px. [Measured comparison](header-comparison.json) records matching mark/title bounds and typography; phone mark x=20, title x=62. The loaded-reference drawer action is inert, and the frame uses fixture workspace data and native services. Images use `header-{before,loaded,after}-{bone,obsidian}-{360,1200}.png`.

Follow-up checks: root typecheck; component policy with the shared identity registered; error/control guards; workspace identity, Room-list layout and live recovery tests; source-bound error browser proofs; and the 532-frame implementation matrix. The error state preserves the approved control count in every region.
