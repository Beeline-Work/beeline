# Parked runtime ownership

Reproduction PARK-LEASE-1: use two VoiceService instances sharing a real Pglite database, join through the owner, dispatch pending work, park, wait 25 seconds without audio, then resume through the nonowner. On a738cbf2f the nonowner claims the expired 20-second lease and creates a replacement RTC runtime; resume throws `voice transport disconnected` in the RTC fixture.

The regression now passes: the original runtime renews its ownership lease every five seconds while connected. Renewal performs only an owner-fenced UPDATE, without reading reports or reopening STT. Close clears the timer. After the same 25-second park and nonowner resume, runtime_owner is unchanged, VoiceRoomRuntime.connect was called once, and the retained RTC data channel resumes the original runtime.

Run: `npm test -w @beeline/server -- src/voice-room-runtime.test.ts -t PARK-LEASE-1`.

RTC, STT and speech providers are doubles; both services and PostgreSQL lease decisions use real Pglite. Device acceptance was waived by the owner and not run.
