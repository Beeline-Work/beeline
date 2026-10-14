# Reproduction voice-double-reply

## Production observation

Read-only Neon inspection on 2026-10-13 confirmed the screenshot's DM
(`79efa989-fecd-4276-8ff3-ece8e2cf5a36`). Times below are UTC; 02:26 on
October 14 is 22:26 October 13 in New York.

| Time | Record | Provenance |
| --- | --- | --- |
| 02:26:18.334877 | `ecfbc0b3…2162`, “I’m listening…” twice in one stored text | `openai/gpt-6-luna`, no request ID |
| 02:26:33.044998 | `edcfb860…82a7f`, human skepticism about the fix | source of both a voice order and ordinary command |
| 02:26:34.637163 | `fc894766…4eb35`, first Ruby answer | `openai/gpt-6-luna`, no request ID |
| 02:26:49.132528 | `5964e231…0394`, second Ruby answer | `default`, request ID matching the human source |

The command is `3baaa1cd…c3be6`, reason `direct_message`. Its source also
belongs to `voice_orders` for call `2cb2f680-ddb3-4df1-bc62-a526c0958fc6`.
This proves a voice handoff and a visible voice answer for the same source,
followed by the ordinary agent's answer. It does not establish a stale runtime
as the cause. The earlier call-ended card alone does not prove there was no
subsequent call.

The listening duplicate is one database message containing two renditions,
not two inserts of the same streamed/final reply. Current `OpenRouterVoiceBrain`
accumulates content deltas; `VoiceRoomRuntime` posts that final text, or partial
text after interruption. The production record establishes duplicate content,
but no raw provider stream was retained to identify why Luna repeated it.

## Isolated reproduction and demonstration

No Android device was attached (`adb devices` returned an empty device list).
The service-path proof uses disposable PGlite data and mocked RTC transport and
provider output, without production writes or installed helper lifecycle calls.
It exercises actual voice dispatch, ordinary command claim, daemon completion,
and the phone's transcript projection.

```sh
npx vitest run apps/server/src/voice-room-runtime.test.ts \
  apps/server/src/voice-service.integration.test.ts \
  apps/server/src/voice-providers.test.ts --maxWorkers=2 --minWorkers=1
```

Before the fix, the order tests observed a voice `recordAnswer` alongside the
dispatch. The repeated-rendition test read both formatted and plain copies from
the database. Three assertions failed.

After the fix, the demonstration submits “Ruby reproduce the bug,” claims its
ordinary command, and completes it through `DaemonService.postRoomMessage`.
`PhoneService.readRoom` returns exactly one visible agent reply. A subsequent
conversation-only utterance receives one voice answer even when the provider
returns the screenshot's repeated formatted/plain rendition. The proof prints:

> Reproduction voice-double-reply: voice handoff → ordinary agent completion → phone shows exactly one reply; repeated Luna rendition → phone shows one rendition.

The spoken handoff acknowledgement remains audio-only; normal work owns its
visible reply. Conversation-only replies remain in the ledger. Different
paragraphs and intentional in-sentence repetitions remain intact. This proof
does not claim real-device audio validation or a production deployment.
