# Revised revision 7 Android owner review

These seven full-phone Android captures replace the initial revision 7 set rejected by Ruby. The owner hold remains. They use the real app and seeded Room, with local PGlite, LiveKit and a Node participant as Sam. STT/brain/tone speech remain deterministic substitutes. No production data or release was used.

| State | File | Artifact |
| --- | --- | --- |
| Agent speaking | [01-speaking.png](01-speaking.png) | 7e2fe7ba-0a3b-44ab-ace6-6ed810253cec |
| Muted | [02-muted.png](02-muted.png) | 075718bb-d173-43b7-adeb-c226cc99d38d |
| Two humans, Ending in 10s | [03-countdown.png](03-countdown.png) | a2453136-de47-407e-8cf6-72f20f5f5626 |
| Quiet ended, System line last | [04-ended-quiet.png](04-ended-quiet.png) | edcb79b0-8cab-401c-a2e9-f564efb6b6fc |
| Last stop, duration only | [05-ended-last-stop.png](05-ended-last-stop.png) | 6a89b687-d68f-4808-b7ed-5f17d9969cf3 |
| You left; Sam remains and Join appears | [06-left-others-stay.png](06-left-others-stay.png) | 4ebfd6d6-d883-4d11-977b-c8c074f84b7f |
| Five Rooms, call time in the normal time column | [07-room-list.png](07-room-list.png) | 7d0bd921-c9f4-4037-9522-16aedcf6c405 |

## Reproduced

Reproduction **voice-review-r7-2**: the initial leave capture caught the normal composer before the committed leave roster had reached the header. The server DTO in that run already contained Sam only. The revised capture waits for that committed roster; both the pill and deck now use `voiceCallHumanNames`, and regressions apply the committed leave DTO and verify that the viewer disappears while Sam remains. No participant is removed based on local silence or transport state.

The initial proof also left a deliberately dispatched agent command pending, without a report. That produced the empty pending-agent row and the activity ring. The revised seed does not dispatch that work. Completed replies have bodies and timestamps, and there are no empty agent rows in the captures.

The ended call reused its start timestamp, placing its existing System line before later speech. The revised service retains the same card and System wording, and sets the row timestamp to the call end when it becomes an ended System line. The real service/phone-read regression asserts that it is the newest row after intervening human speech.

## Demonstrated

Alex joined Sam, asked Ruby by name and received RTC tone audio. Capture 1 shows the speaking outline on the agent strip and the moving waveform. Capture 2 follows a mic tap and shows the slash and flat waveform. Alex then pressed stop; after the committed roster refresh, capture 6 shows only Sam with Join. [left-chats.json](left-chats.json) records the matching server list DTO. Alex rejoined the same call. The rendered countdown was sampled until exactly `Ending in 10s` with two humans, then both participants ended after the shared quiet window. [countdown-observations.json](countdown-observations.json) records the rendered state transitions; [room-quiet-ended.json](room-quiet-ended.json) records the final System line as the newest message.

Starting another solo call and pressing stop produces a second existing System line with duration only, as [room-last-stop.json](room-last-stop.json) and capture 5 show. Sam then starts another call for the five-Room list capture. The call time uses the same `ConversationRow` age element and style as every other row (ConversationRow.tsx, age element and styles.age); it aligns with 14m, 30m, 47m and 1h in capture 7. No alternate call-time inset was added.

Every Room capture is at the newest message, with no jump badge or Beginning of Room label. [icon-overlay-check.json](icon-overlay-check.json) compares glyph pixels: mic bounds remain x875–906/y2237–2281, the muted slash widens symmetrically to x871–910, and the filled stop remains x960–1002/y2238–2280. Normal conversation entry restores the same center.

## Existing transcript activity mark

Main already passes `alive: speakerWorking` in RoomMessageVariants.tsx:1481 and `alive: message.isAgentLiveTurn === true` at line 1590. Ledger.tsx:360 forwards that to IdentityMark; IdentityMark.tsx:354 draws its existing activity ring. These are unchanged. There is no call-speaking state passed to transcript avatars. The new speaking outline is confined to VoiceBar's agent strip. The revised seed has no pending work, so the transcript avatars have no activity outline.

## Validation and limits

43 focused mobile cases (header, committed roster delta/store and deck preview), 19 service integration cases and 74 System-lock cases pass. Root typecheck and UI policy pass. Main conflicts were resolved in b433ea2b3 before this follow-up. This UI capture work does not alter the turn path; the matched first-audio evidence in the initial revision 7 directory remains 18.024 ms before / 16.150 ms after with controlled providers and RTC, not physical-speaker or live-provider timing.

The runtime-39 Android debug binary loaded this checkout's JavaScript through Metro. Its temporary local-auth boot, LogBox suppression and entry import were removed afterward. Expo's development tools button was disabled through its emulator-only preference. The pending-work hold, routing and reconnect proofs remain in the parent proof directory; the revised screenshots do not replace those lifecycle reproductions. The UI itself is not a defect report.
