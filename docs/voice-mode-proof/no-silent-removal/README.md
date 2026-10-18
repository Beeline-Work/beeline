Current owner review: [revision 6 real-Room Android captures](owner-review-r6/README.md). Earlier UI and solo-silence evidence below is historical where superseded by the current brief.

# Voice call proof, revision 3

Reproductions **multi-human-silence-1**, **multi-human-mode-2** and
**call-wide-end-3**. All phone proof uses Android API 36; no release was made.

The revised app has no per-person silence deadline, parked microphone state or
native timer. Solo and group calls share the runtime owner's 60-second quiet
window. Pending/claimed commands count only through this call's `voice_orders`;
completed command timestamps restart the window even between server checks.
Raw mic frames, old `idle` requests and outside agent work do not reset it.
The end transaction rechecks activity and owner authority before committing.

The rebuilt debug APK exercises production `useVoiceCall`, `VoiceBar`, native
capture and `VoiceCallCard`. Both humans use real LiveKit transport. Final text,
brain decisions and tone TTS are injected in a disposable database. This tests
membership, STT input frames, rendered controls and accepted audio; it does not
measure production provider or physical speaker latency.

## Current demonstrated paths

- [Call-wide result](call-wide-end.json): both humans stay while one talks unnamed
  for 60 seconds, no extra agent replies, and confirmed stop retains membership.
  After the final call work finishes, both humans leave together after **61.83 s**
  of quiet. The ended native card has no Join control: [Android](call-wide-ended.png).
- [Mode result](mode-switch.json): Leave switches the remaining person to solo;
  unnamed speech answers through the last agent. Rejoin broadcasts 2 to both
  transports and unnamed speech becomes `unaddressed`. An actual 30-second RTC
  disconnect without Leave retains group rules throughout. This is a controlled
  RTC disconnect, not a physical radio outage.
- [Pending-work result](call-wide-pending.json): both humans remain after 65
  seconds of complete silence while the call's command is pending. Native mic
  frame counts continue increasing. Completing that command starts a fresh quiet
  window; everyone exits **61.86 s** later and the card removes Join.
- [Outside-work result](call-wide-outside.json): a command without a call
  `voice_orders` row remains pending while both humans leave together after
  **61.16 s**. The [ended Android card](call-wide-outside.png) has no Join control.
- The baseline [old result](old.json) still records the original defect on
  `4049229b6`: the native per-person deadline removes the listener and subsequent
  unnamed speech goes to Ruby.

The new controls read **End call** in solo and **Leave call** in group. Native
changes require the new Android 39 / iOS 36 runtime fingerprints; older binaries
remain protected by server-side no-op `idle` and the existing ready/resume mic
acknowledgement. The server's automatic end uses the existing ended-card producer;
no new visible System message was introduced.

`prove-multi-human-silence.ts` starts the isolated service and real RTC partner;
`prove-voice-call-mode.py` drives mode changes; `prove-voice-call-end.py` verifies
quiet work and outside-work cases with the native view. The local HTTP adapter
uses service methods directly, without production sign-in. No production call,
helper daemon or release is changed.

## First-audio timing

The [matched local comparison](paired-first-audio.json) uses one warmup and five
turns per revision, actual local LiveKit capture, the same deterministic brain
and tone TTS, and the same paused validation load. Median first voiced audio is
**40.98 ms original / 42.81 ms final**. These small samples overlap and do not
establish a provider-latency change. The end rule adds no awaited read, buffering
stage or delay to ordinary final speech; its work queries run on the owner’s
quiet checks and committed refreshes. Live-mode routing still uses its required
current membership read. The Android outside-work run records its separate
samples under concurrent validation load; neither run measures physical speaker
latency. Historical 13.25 / 14.43 ms results below came from earlier runs.

## Historical revision 1 / 2 evidence

The material below records the previous brief and its now-replaced solo parking
policy. The revision 3 implementation and current evidence above supersede it.


Reproduction **multi-human-silence-1**, Android API 36, 17 October 2026.
The native debug APK runs the production `useVoiceCall`, `VoiceBar`, Android
background service and 20-second native deadline. Both humans connect through
LiveKit v1.9.12 to a disposable Pglite Workspace using the real VoiceService and
VoiceRoomRuntime. No production call, installed helper or release is changed.

The closest controlled stand-in injects final text and a deterministic brain
and tone synthesizer. It exercises real RTC audio publication, native microphone
capture, idle/state/resume, database membership and rendered controls. Live Flux,
Luna and Aura are not part of this proof; physical-device speaker latency and
recognition accuracy are not measured. The local proof HTTP adapter calls the
same service methods without production sign-in.

## Reproduced

The first old-code service regression returned `ended` rather than `ready` for
a listener while two people were present. The Android comparison then ran the
original hook, service and runtime from commit `4049229b638616cb9a330cd66c4bc0799f2f6447`.

Two humans joined. Alex's unnamed final text arrived every five seconds while
Sam listened on Android. Sam's native deadline called idle and removed Sam;
after 60 seconds the database held one human and subsequent unnamed speech
produced Ruby replies. [Old result](old.json) records the two-to-one membership
transition, idle/leave requests and the reply count changing from one to nine.

## Demonstrated

- [Fixed result](fixed.json): after 60 seconds both humans still have null
  `left_at` and `parked_at`; unnamed speech yields `unaddressed` without another
  agent reply. Injecting Sam's confirmed stop phrase retains both humans.
- [Old-client result](old-client.json): the original Android hook reaches its
  native deadline on the fixed server, follows idle/state/resume and republishes
  an unmuted microphone with received PCM frames. The server explicitly acknowledges idle playback during resume so the original hook unmutes. It can briefly mute every
  20 seconds until updated, but it neither leaves nor stays permanently muted.
- [Solo result](solo.json): after Alex leaves, the updated Android listener
  receives the one-human count, rearms its native deadline and leaves after
  silence. Pending-order parking also passes the existing service regressions.
- Existing transport-loss coverage still retains a missing participant at
  115 seconds and removes it at 120 seconds. No grace interval was changed.
- Both native themes show a separate labeled Leave call button. Solo retains
  the existing End Conversation mode accessible control.

![Bone call control](android-bone.png)
![Obsidian call control](android-obsidian.png)

## Live call mode (revision 2)

Reproduction **multi-human-mode-2** uses the same Android APK and real RTC,
with Android as Alex and the controlled Node RTC client as Sam. Sam's Leave
endpoint invokes the real service leave method; rejoin uses its join method.
Android observes count one immediately after Leave, and unnamed speech gets
one Ruby reply under solo rules. On rejoin, Android's next count is two and the
partner's first count signal is two. Unnamed speech becomes `unaddressed` again.

The partner's RTC transport is then disconnected without a leave request for
30 seconds. Android and the database stay at two humans throughout; no idle
request occurs even after the former solo deadline would have expired.
The partner reconnects using its still-valid call token. This is a controlled
RTC-loss stand-in, not a physical handset radio outage.

[Mode transitions, 30-second checkpoints and repeat timings](mode-switch.json)
record the run. The additional five warm first-audio samples have a median of
14.43 ms, compared with the original 13.25 ms baseline and 12.28 ms first fixed
run. These small local samples include ordinary run-to-run variation; they do
not establish live provider or speaker latency. Normal final input shares
routing's existing live-count read for interruption, adding no serial lookup.

The server no longer uses its last announced count for decisions. Announcement
reads are serialized, and joins, leaves and sweeps notify after their database
commit. Existing committed-message invalidations reach an RTC owner on another
server. Parked participants and participants inside reconnect grace still count.
Client regressions cover cancelling an almost-expired solo deadline on rejoin;
server regressions cover membership changing while agent access resolves and
interrupting with a count different from the last announcement.

Repeat with `SILENCE_PROOF_ANDROID_FIRST=1` on the proof service, join from
Android, then run `python3 scripts/prove-voice-call-mode.py --device <serial>`.

## Routing investigation

Read-only production inspection confirmed the recorded 20:36:44 Emberus route.
The persisted messages and participant rows do not retain tap, partial-STT or
continuation provenance, so the exact trigger cannot be reconstructed from them.
The runtime does contain a reproducible bypass: before the first audible frame,
a later unnamed final can inherit the pending turn's agent even with two humans.
The regression uses the reported unnamed phrase during that window; it now gets
`unaddressed`, with no source revision or new brain request. Name matching,
one-turn tap behavior and report playback are unchanged.

## Timing

[Five warm samples](timing.json) measure injected final text to first voiced
audio publication through actual local RTC. Median before: **13.25 ms**;
after: **12.28 ms**. These deterministic-provider samples check the local path,
not live provider or phone speaker latency. The turn path adds no network call,
timer or buffering stage; the additional reads are in idle and stop handling.

## Repeat

The fixture entry is `apps/mobile/scripts/multi-human-silence-native-proof.tsx`;
the disposable service is `scripts/prove-multi-human-silence.ts` and assertions
are `scripts/prove-multi-human-silence.py`.

Start a dedicated LiveKit dev server with ports 17890 (HTTP), 17891 (TCP RTC)
and 17892 (UDP RTC), using local-only `devkey`/`secret`. Advertise a host address
reachable by both the emulator and Node clients. The captured run used
172.17.0.1. Start the service with:

```sh
node --import tsx scripts/prove-multi-human-silence.ts
```

For the native fixture, temporarily make the mobile entry import
`./sources/unistyles` before `./scripts/multi-human-silence-native-proof`.
Use Metro aliases for the fixture only: `@/auth/monolith-session` forwards
`fetch`, `@/sync/transport/live-connection` provides inert register/connected
subscriptions, and `./client-error-report` provides error formatting with an
inert reporter. Keep the native voice transport, RTC and timer modules real.
Set `EXPO_PUBLIC_BUZZY_MONOLITH_URL=http://10.0.2.2:18097` for Metro on port 18098.
Build using Expo prebuild and Gradle assembleDebug for x86_64 with two workers
and a 4 GiB Gradle heap. Install only on a task-owned emulator, grant microphone
permission, open the development client and press Join proof call.

```sh
python3 scripts/prove-multi-human-silence.py --phase fixed --output /tmp/fixed.json
```

For the old comparison, extract the three source files from the commit above
into sibling `.silence-proof-old-service.ts`, `.silence-proof-old-runtime.ts`
and `.silence-proof-old-hook.ts` files. Point the old service import at the old
runtime, point the fixture at the old hook, and run the server with
`SILENCE_PROOF_OLD=1`. Use `--phase old`. Run the old hook against the fixed
server with `--phase compat`; use the updated hook and `--phase solo` to verify
rearming. Start a fresh disposable service for each phase. Restore the mobile
entry/config and delete the extracted sources after the proof.
