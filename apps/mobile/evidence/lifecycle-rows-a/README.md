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

## Call-site delivery

Under brief revision 3 and lunchboxfortwo’s approval (4b36966b), only the
createCorner System-line lock entry changes. The existing producer now writes
its Room record plus a source-anchored projection into the command’s transcript
when that transcript has an ordinary requesting message. A Room source uses
one record for both roles. Automatic wakes and private orders/reports without
transcript messages receive only the Room record; no historical root is borrowed.

The new corner-callsite.integration.test.ts exercises createCorner followed by
PhoneService.readRoom against an isolated database. It proves Room, DM and
parent-corner placement, DM access rejection, idempotent retries, source-free
wakes, workflow-card exclusion and silent push delivery. Private agent-to-agent
orders/reports live in agent_commands, not transcript messages, and are skipped.

The native DM and parent frames replay the actual phone read responses exported
by that test into scripts/corner-callsite-proof-snapshot.json. This is a local
service-to-UI proof, not a production write or a signed-in production session.

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
fixtures and exported local service responses; no production session, messages, credentials or releases are involved.

Generate ignored Android files using Expo prebuild; set react.entryFile in the
generated app build.gradle to ../../scripts/lifecycle-rows-a-native-proof.tsx;
disable Expo Updates in the generated manifest. Build assembleRelease for
x86_64 with two workers and a bounded Gradle heap. Install on a leased emulator.

The harness offers Bone/Obsidian, a frame selector and callback destination
receipts. Expand the first run, tap its GitHub number and corner arrow, then
select the single/long frame and expand its long run. DM and parent-corner frames replay the real service projections and show the
source marker alongside the Room record.

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
expanded, collapsed, single/long and service-projected DM/parent call-site frames in both themes.
See android-receipts.json for destinations and tap bounds; android-build.json
identifies the proof APK. The adjacent snapshot records the local service response used by the native proof.

## Shared reading face (brief revision 4)

PrLifecycleCard.test.tsx now renders grouped PR/issue rows, the standalone
LifecycleCard adapter and CornerOpenedMarker together. It verifies that every
explicit font is Space Grotesk and that marker meta and row body share the
Regular face. The tool-run line retains its machine role.

The native harness also has a Room frame with a source marker directly above
a PR row, plus the unchanged mono tool-run reference. Capture just this frame
in both themes with the capture script’s --shared-face-only option.

Captured: [Bone](android-bone-shared-typeface.png) and
[Obsidian](android-obsidian-shared-typeface.png). The adjacent XML and
android-shared-typeface-receipts.json preserve visible text and the verified
PR destination. android-build.json records this additional proof APK separately.
