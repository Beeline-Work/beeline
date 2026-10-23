# Transcript event rows v2

This is a feature request, not a defect report. Owner-approved locked mock v2,
expanded by brief revision 2 to all tracked lifecycle/notice cards.

## Tap-data finding

No corner/PR/issue card tap counts exist in the application instrumentation.
`track/tracking.ts` enables PostHog app-lifecycle events; `track/index.ts` sends
only OTA available/applied events. `LifecycleCard`, `PrLifecycleCard`,
`CornerOpenedMarker`, `openCorner` and `handleOpenGitHubEvent` do not capture
taps. Searches for analytics, tracking, capture and telemetry found no card-tap
producer. This is absence of collected data, not a measured count of zero taps.

## Complete transcript card inventory

The inventory follows `PhoneService.messageView` and `_chat-surface.renderMessage`,
plus the poll rendered by `OrdinaryLedgerMessage`.

| Type | Treatment and reason |
| --- | --- |
| `github-event` PR opened/merged/closed; issue filed/closed and any delivered commented/reopened event | Fold. One line per event, not one latest-state record per identity. No event producer or DTO guard changes. |
| `github-corner-note` (system lines): PR opened/merged/closed, checks started/passed/failed, push, merge conflicts and other GitHub notices | Fold. Structured GitHub subject and destination preserve the existing event; notices without an item URL remain readable. |
| `daemon-fact:corner-open` | Existing `CornerOpenedMarker`, standalone or under its source message. |
| `daemon-fact:corner-complete` with landed PR | Fold as PR merged, retaining PR and corner destinations. This is the parent's actual merge record. |
| `daemon-fact:corner-complete` without a landed PR; `worktree-cleaned` | Hidden. These are corner closure/cleanup noise. A settled opening card whose original event kind is still `corner-opened` retains its opening marker; it never renders a closed marker. Other closes disappear. |
| `daemon-fact:checks-failing` | Fold as checks failed, retaining the corner destination. |
| `wallet-tx`, `wallet-delegation` | Fold passive payment receipts and recorded signing grants. Keep amount, chain, counterparty, remaining balance, expiry/revocation wording and transaction link. |
| `wallet-insufficient` | Separate: the person needs the missing funds/reason to resolve the refused payment. |
| `permission`, `grant-request`, `squire-approval` | Separate: authorization decisions and their outcomes retain the original actionable control context. |
| `computer-session`, `app-sign-in`, `agent-sign-in`, `repository-onboarding`, `target-branch` | Separate: session takeover, authentication, repository setup and branch selection require a person to act. |
| Poll, `choice`, `connector-offer` and connector receipts | Explicitly excluded by the owner. |
| `agent-command` | Ordinary agent prose with recipient mention; orders, reports and requests for decisions never fold. |
| `voice-call` | Active calls remain outside the transcript below the header; ended calls keep their existing system line. |
| `corner` | Already not rendered in the transcript; no change to corner list/screens. |
| `corner-app` | Separate navigation entry to an app, not a lifecycle/notice event. |
| Room updates, durable facts, ordinary system lines, artifacts and attachments | Already ledger content or user content, not lifecycle/notice cards. Preserve existing behavior. |

A human or agent message, an actionable card, or an ordinary system line ends a
run. A corner-open marker keeps its own position and starts a new run after it.
Hidden cleanup does not split a run. Unread boundaries continue to split runs
through the existing `foldTranscriptRows` boundary logic. Folded ids retain
message jumps, new-message counts and read cursor anchors. Posted check history
stays historical; the corner header continues to own current live check state.

## Demonstration

`scripts/transcript-event-room-snapshot.json` contains read-only events from the
real #beeline Room `bb91a1c7-7cad-4fde-aafc-94fccb651ac8`, captured on 2026-10-21.
The two runs are actual contiguous event spans separated by real chat. The first
has issue #2722 and merged PR #2721. The second has merged PR #2693, corner
room-viewer-crash opening, and merged PR #2694. The corner marker remains between
the two merge rows; the proof never joins events across that marker or chat.

The Android proof replays these real Room events through production folding,
`CornerOpenedMarker`, `NotificationLifecycleCard`, and the same `LedgerDisclosure`
used for steps. It does not modify production messages or require a release.
This is a snapshot replay in a task-owned Android app, not a claim that a live
signed-in Room session ran the unreleased code. The clean leased emulator has no
owner session; the closest stand-in avoids copying private sign-in material.

Browser coverage drives expansion/collapse and exact PR/issue/corner callback
destinations at phone and desktop widths in both themes. Grouping tests also
cover messages/decisions, issue commented/reopened states, check history,
passive wallet records, missing metadata, suppressed closure and message anchors.

The disclosure top-edge refinement is documented in
[disclosure-top-edge](../disclosure-top-edge/README.md): steps, check-event runs
and grouped GitHub headers have no top rule and retain a 44 px minimum tap
height. GitHub-only groups now use their own header in
`NotificationLifecycleCard`; steps and other event runs use `LedgerDisclosure`.
The older screenshots below predate that refinement.

## Repeat Android proof

Generate ignored native files with `npx expo prebuild --platform android --no-install`.
In `android/app/build.gradle`, set `react.entryFile` to
`file("../../scripts/transcript-events-native-proof.tsx")`. Disable Expo Updates
in the generated manifest. Build `:app:assembleRelease` for `x86_64` with two
workers; install only on an emulator leased by `beeline emulator`.

After launching the proof app on the leased emulator, run from repository root:

```sh
python3 scripts/prove-transcript-event-rows.py --serial emulator-<leased-port>
```

The proof provides two real event runs and an original-card toggle. Tap the
summary to expand/collapse; links print the exact callback destination below.
No production navigation or message mutation is needed.

## Results

Android 36, leased `emulator-5566`, production fonts, Bone theme:

- [Original card adapters](android-before.png)
- [Collapsed issue + PR run](android-collapsed.png)
- [Expanded event lines](android-expanded.png)
- [Corner-open marker between PR event rows](android-corner-open.png)

[Android callback receipts](android-results.json) record the APK hash and exact
issue, PR and corner destinations. The adjacent UIAutomator XML preserves the
accessibility labels and bounds. Tapping, collapsing and the absence of any
closed-corner line were checked on-device.

Validation: full root `npm run typecheck`; 234 tests across 12 affected grouping,
component, message-boundary, browser and design suites; UI component policy;
dead-code baseline (4 existing findings, zero introduced); Android release proof
build for x86_64. No native source changes, release or production write.
