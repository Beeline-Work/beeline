# Beeline voice mode

Hold the existing composer mic to start voice mode. A short press still starts
text dictation. Voice stays in the conversation: tap an agent's square avatar,
or say its name, to aim your words. The pressed mic ends your participation;
hold the waveform to open the optional full-screen view. Room members join
through the live call card. After the last person leaves, that card becomes
`Voice call ended · duration`.

Workspace owners and admins choose **Voice provider** in Workspace settings:
Aura-2 (default), Kokoro on OpenRouter pinned to DeepInfra, or Fish S2.1 Pro.
Each provider assigns distinct library voices using the agent's identity and
soul, with an optional `Aura:`, `Kokoro:` or `Fish:` voice id in its soul.
Fish uses licensed English library voices; no voice cloning is performed.

## Authority and transport

`apps/server/src/voice-service.ts` owns membership, calls and command dispatch.
`voice-room-runtime.ts` owns live audio, targeting and playback. One LiveKit
transport participant speaks as the existing agents; it is never a Beeline
identity. Ordinary human and agent messages form the transcript. Luna's voice
conversation uses `openai/gpt-6-luna` through OpenRouter with reasoning disabled.
External work is dispatched through `routeHumanMessage`, the existing command
grammar. Real agent reports are matched to their original command and spoken
back. Agent work has no voice timeout and continues independently of playback.
Flux receives raw 16 kHz mono PCM over Workers AI WebSockets; speech providers
stream 24 kHz mono PCM into LiveKit. Barge-in interrupts playback, never the real
agent's command. Live call ownership uses a database lease across server Machines.

## Deployment

The self-hosted Fly app is `beeline-voice-livekit` in `iad`, beside
`beeline-server`. `fly.beeline-voice-livekit.toml` and
`infra/voice-livekit/start.sh` define the pinned image and ports: TLS signalling
443, RTC TCP 7881, UDP mux 7882. Allocate a dedicated IPv4 and set
`LIVEKIT_NODE_IP` to it. The single shared CPU/256 MB Machine was proved with
two RTC human participants (about 42 MB idle RSS).

Server secrets:

- `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` (same key pair as LiveKit).
- `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_WORKERS_AI_TOKEN` with Workers AI permission.
- Existing `OPENROUTER_EMBEDDING_API_KEY`, or `BEELINE_VOICE_OPENROUTER_API_KEY`.
- `FISH_AUDIO_API_KEY` for Fish. Selecting Fish without it returns a clear
  configuration error; it never silently substitutes another provider.

LiveKit credentials are server-only; phones receive scoped call JWTs. Configure
the secrets before the ordinary unified release. This change requires a native
mobile build for LiveKit/WebRTC: Android runtime 34, iOS runtime 33. The preceding
runtime pins remain in the OTA compatibility list.

Workers AI's free daily neuron allowance is insufficient for continuous voice.
At HTTP 429/code 4006, Flux and Aura need a quota reset or a Workers Paid plan.
Kokoro and Fish do not consume that allowance for TTS; all providers still use
Flux for STT. Billing changes remain an owner decision.

## Isolated proof

`scripts/prove-voice-mode.ts` creates a disposable in-memory Workspace, two
humans and two temporary agents. It runs the authenticated server, actual RTC
clients and real provider audio, then claims an ordinary agent order, creates
a greeting file in the ignored proof directory, and submits its report through
the authenticated daemon API. No installed helper or existing Workspace is used.

Run with credentials supplied only through the process environment:

```sh
VOICE_PROOF_LIVE_FLUX=1 BEELINE_VOICE_TTS_PROVIDER=aura-2 \
  node --import tsx scripts/prove-voice-mode.ts
```

Set `VOICE_PROOF_COMPARE=1` for three identical spoken prompts; use
`kokoro-deepinfra` or `fish-s2.1-pro` to compare providers. `VOICE_PROOF_LABEL`
selects the ignored output subdirectory. `VOICE_PROOF_HOLD=1` retains the local
server for the browser fixture (`scripts/serve-voice-ui-proof.ts`) until SIGINT;
cleanup removes the temporary Workspace and clients. Session files contain
local proof tokens and must never be committed.

Captured on 2026-10-13, three live Flux→Luna→speech turns per comparison:

| Transport / speech | End-of-turn to first server audio, ms | p50 |
| --- | --- | --- |
| Local LiveKit / Aura-2 | 1870, 911, 930 | 930 ms |
| Local LiveKit / pinned Kokoro | 4092, 3866, 1313 | 3866 ms |
| Fly 256 MB LiveKit / Aura-2 | 1217, 1042, 1547 | 1217 ms |

These are three-sample server measurements, not phone speaker measurements.
Captured artifacts: [Aura-2](voice-mode-proof/aura-2.json),
[Kokoro](voice-mode-proof/kokoro-deepinfra.json),
[Fly transport](voice-mode-proof/fly-256mb.json), and
[the earlier browser voice-bar capture](voice-mode-proof/room-voice-bar.png).
Both humans received actual audio; named targeting changed Ruby to Sol without
waking a real worker for conversation. External work was claimed, a file was
created, and its authenticated report was spoken. Browser proof exercised Join,
the 56 px voice bar, long press and mic exit. Mock acceptance is the approved
pass 08 board; the earlier browser capture used a minimal source-component
fixture, whose font-loading issue was corrected in the proof server.

**Pending by firstmate's delivery instruction:** Fish live proof (key pending),
real-phone first-audible-word latency, and the final phone comparison with the
approved frames. Cloudflare's exhausted free quota prevents a fresh live Flux
rerun tonight. Kokoro showed transient playback failures during the earlier
comparison and did not meet the target latency. Do not treat the table as an
under-one-second phone acceptance claim.

Regression coverage: `voice-providers.test.ts`, `voice-room-runtime.test.ts`,
`voice-service.integration.test.ts`, `ConversationComposer.speech.test.tsx`,
and `chat-list-delta.test.ts`.
