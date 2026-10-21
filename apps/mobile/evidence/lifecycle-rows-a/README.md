# Locked mock A lifecycle rows

Feature request, not a defect report. The approved mock replaces crowded mono
PR/issue rows with Space Grotesk body text, separate GitHub number and corner
navigation, two-line titles and a meta summary. Single events omit the summary;
long runs retain the bottom “N more” disclosure.

Corner-open facts without a resident source render as ordinary lifecycle rows.
The existing anchorCornerMarkers pass still attaches resident markers beneath
their source message before lifecycle folding. The Room fallback contains no DM
identity or branch glyph. Original corner-open events retain their opening
meaning after server settlement changes their fact payload.

## Scope pending approval

The System-message lock and createCorner producer are unchanged. The server
still writes agent-opened corner facts only to the parent Room. A new private
DM projection requires lunchboxfortwo's pending lock approval. A fixture showing
a resident DM source proves presentation only; it does not prove server delivery.

## Validation

- Root typecheck, UI component policy, calm and design lints pass without baseline growth.
- Component tests exercise separate GitHub and corner callbacks, no arrow without
  a corner, body/meta families, title line cap, touch target dimensions, single,
  collapsed and long-run cases, and resident/nonresident source behavior.
- Browser tests replay existing real Room snapshots at phone and desktop widths,
  in both themes and reduced-motion settings, verifying exact destinations.
- Desktop inspector and Room store tests preserve resident markers and navigation.

## Repeat native proof

The task-owned harness is scripts/lifecycle-rows-a-native-proof.tsx. It imports
production components and folding, production fonts and both themes. It uses
fixtures; no production session, messages, credentials or releases are involved.

Generate ignored Android files using Expo prebuild; set react.entryFile in the
generated app build.gradle to ../../scripts/lifecycle-rows-a-native-proof.tsx;
disable Expo Updates in the generated manifest. Build assembleRelease for
x86_64 with two workers and a bounded Gradle heap. Install on a leased emulator.

The harness offers Bone/Obsidian, a frame selector and callback destination
receipts. Expand the first run, tap its GitHub number and corner arrow, then
select the single/long frame and expand its long run. The DM frame is explicitly
presentation-only until the private server projection is approved and tested.

Capture and destination verification:

```sh
python3 apps/mobile/scripts/capture-lifecycle-rows-a.py \
  --serial emulator-<leased-port> \
  --out apps/mobile/evidence/lifecycle-rows-a
```

The GitHub tap region includes the number and surrounding copy so the inline
text flows naturally across both lines while retaining a full-height link
region. The corner arrow is a separate target; tapping it never opens GitHub.

## Native results

Android proof build succeeded. The capture script passed in Bone and Obsidian:
GitHub number targets produced the exact PR and issue URLs; the corner chevron
produced its corner id; issues without a corner had no arrow. The long-run
disclosure revealed all remaining rows. Screenshots and UIAutomator XML capture
expanded, collapsed, single/long and DM presentation frames in both themes.
See android-receipts.json for destinations and tap bounds; android-build.json
identifies the proof APK. DM server delivery remains pending approval.
