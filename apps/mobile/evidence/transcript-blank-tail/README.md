# Phone transcript blank tail — Reproduction R1

Restore the phone FlatList's initial retained window from two rows to ten.
Keep four-row later batches, the five-viewport moving window, and native
`minIndexForVisible: 1`. Desktop rendering still short-circuits the phone
source-landing limit, so desktop behavior is unchanged.

## Reproduced

On assigned Android emulator `emulator-5626`, open Beeline Review Workspace
`bee11e00-0000-4000-8000-000000000105`, Room
`392a8792-4395-400b-824f-f15b0db2c719` (`thinking-line-79`). Keep the Room open,
send a short message, then ask Ruby for twenty numbered paragraphs about
organizing books. Leave the phone transcript visible as the agent responds.

R1: the latest prompt and Ruby's working indicator remain, but the previously
visible entries disappear, leaving most of the area above the prompt blank.
[R1-before.png](R1-before.png) records that wrong state. This is the reported
blank-tail family, with one visible prompt in this captured frame rather than
exactly two final agent messages. The keyboard was open; no voice call was
started for this check.

The first capture used an unprofiled Android export of `00b345c83` (main at
checkout), bundle SHA256
`31c95361135174d809876e9a51d631053b465859b0dab82315efa4ecfef41204`.
The source had `PHONE_FIRST_RENDER_ROWS = 2`. The installation's original
launch bytes were backed up before replacement. A newer production update
arrived during the run; subsequent matched profiling arms explicitly replaced
that newest cached launch asset and logged their row budgets.

The failure was intermittent. Later profiled two-row short-answer and
long-answer attempts kept older text visible. The exact native reset trigger
was not isolated, so these captures do not establish a deterministic root-cause
experiment. This is a narrow restoration of the earlier retained row budget,
not a claim that every possible native blanking cause is resolved.

## Demonstrated

Repeat R1 with the ten-row build and the same Room, keyboard, and request for
twenty numbered paragraphs. Earlier answer text stays visible above the new
prompt while Ruby works ([R1-after-arrival.png](R1-after-arrival.png)); the
answer then fills the transcript ([R1-after-answer.png](R1-after-answer.png)).
The fixed run retained forty-five consecutive captures through arrival and
settlement without the blank upper area. New generated answers differ in text;
this is a live-agent path, not an identical replay of server events.

Both profiled arms use the same main source and temporary React Profiler around
the real `RoomSendList`, with React Native's profiling renderer selected in
Metro. Before has two initial rows; after differs only by ten initial rows.
Native console receipts confirm the corresponding budgets. No profiler or
Metro modification is committed.

- Before profiled bundle SHA256: `a35529610bd7ad4bade9ec9557c515bf2101b4ecc753843bc8360221cccbe1a5`.
- After profiled bundle SHA256: `a8a858acc195f7af34f60900f9f77a8cec0045fd6a6dafe2828736f6dea872f1`.
- Existing native binary/runtime: Android runtime `44`; local launch-asset
  substitution only. No OTA was published or emulator started.
- Both replaced original launch assets were restored with exact byte hashes and
  original manifest/hash metadata after measurement.

## Initial mount cost

Use the unchanged `#proof` Room `bee11e00-0000-4000-8000-000000000103` for both
arms. Restart the process, open the Room deck, wait two seconds, deep-link to
that fixed Room, and wait two seconds. Retain the phone-transcript Profiler
mount duration. Four samples per arm, grouped before then after; no build ran
during either capture group. The first attempt per arm was excluded because
its log could retain the preceding `thinking-line-79` mount; both excluded
attempts remain in [raw logs](mount-records.json.gz). The final native UI read
confirmed `#proof`.

| React transcript subtree mount | Two initial rows | Ten initial rows |
| --- | ---: | ---: |
| Median | 24.66 ms | 88.80 ms |
| Maximum | 31.92 ms | 101.02 ms |

[Individual values and scope](mount-cost.json). The added median render work is
about 64 ms; eight more cells enter the initial retained budget. These small,
non-alternating emulator samples measure React render work, not overall
Room-open time, native scanout, a cold cache miss, or a physical-device budget.
They demonstrate the expected rollback cost rather than certify performance.

## Regression and validation

`ChatSurfaceTranscript.test.tsx` exercises the real transcript component's
phone-list configuration through draft replacement and the next arrival. A
short-row fixture needs eight rows to cover a 576dp viewport before later
batches. The two-row source fails (144dp); ten passes. This is a configuration
regression, not an emulation of native FlatList rendering; the screenshots are
the visible-result check. Existing batch/window/anchor settings are asserted.

Root `npm run typecheck` passed. The transcript regression, four Room session
suites, and send-preview suite passed (73 tests). The regression also passed
after removing all temporary profiler changes. Full mobile tests, iOS, active
voice, and physical-device checks were not run; the change is the phone render
budget rollback, and the assigned Android live-message path was exercised.
