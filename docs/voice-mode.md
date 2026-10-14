# Beeline voice mode

Hold the existing composer mic to start voice mode. A short press still starts
text dictation. Voice stays in the conversation: tap an agent's square avatar,
or say its name, to aim your words. The pressed mic ends your participation;
hold the waveform to open the optional full-screen view. Room members join
through the live call card. After the last person leaves, that card becomes
`Voice call ended · duration`.

**Aura 2 is the only active speech provider.** Workspace settings and the server
resolve to Aura 2, including older saved Fish or Kokoro settings. Their adapters
remain dormant. Agent Profile presents Soul, Model / difficulty, then Voice.
The owner can preview an Aura 2 library voice and Save it; other members can
read the current voice. Previews stop after eight seconds, navigation or Cancel.

Saved Aura choices live in `agents.chosen_voices`. Existing Fish and Kokoro
choices map deterministically to an Aura 2 voice until the owner saves an Aura
choice. Room assignment reserves saved voices and resolves collisions among
agents deterministically. The profile opened from a Room shows its effective
assignment. There are no cloning or upload controls.

Say an agent's handle or display name anywhere in the utterance to address it;
matching ignores case and respects word boundaries. Tapping its avatar still
sets the current target. With two or more humans in the call, every utterance
must explicitly name an agent to get a reply, including after an avatar tap.
With exactly one human, unnamed speech follows the current agent.

Playback speaks the full reply, streaming each clause and the remaining tail.
Noise-only Flux starts cannot interrupt it: barge-in waits for recognized speech
and uses word confidence when available. Recent playback fragments are excluded
from input to prevent echo from starting another reply. Flux's
[word confidence fields](https://developers.deepgram.com/reference/speech-to-text/listen-flux)
provide the recognition evidence. An interrupted real-work report stays in the
transcript and does not replay its opening on subsequent refreshes.

A second human uses Join on the Room call card. While connecting, the card says
Joining and the composer shows the avatars. Connection failures remain readable
in both the card and VoiceBar.

`agent-voice.ts` owns library reads, owner saves and bounded previews. The
client renders validated catalog/write receipts, never a guessed voice choice.
The existing native WebView hosts short audio previews without adding a native
dependency or changing the native runtime.

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
agent's command. Live call ownership uses a database lease across server Machines. Concurrent joins
reserve one runtime promise before database work. Each runtime attempt has a unique
lease token; stale cleanup and input cannot release or dispatch through its successor.
Duplicate microphone subscriptions and final STT events cannot start a second stream.

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

LiveKit credentials are server-only; phones receive scoped call JWTs. Configure
the secrets before the ordinary unified release. LiveKit/WebRTC first shipped
in Android runtime 34 / iOS runtime 33. Current runtime pins and fingerprints
are authoritative in `apps/mobile/app.config.js` and `native-fingerprint.json`;
preceding pins remain in the OTA compatibility list. Profile voice selection
reuses existing native modules and introduces no runtime bump.
Regenerate native fingerprints after a clean `npm ci --prefix apps/mobile`;
a warmed dependency tree can produce different hashes from the store/CI install.

### Production TLS trust

The server's `@livekit/rtc-node` participant uses Rust signaling, which loads
the OS CA store through rustls-native-certs. Node's bundled roots do not satisfy
that native library. `apps/server/Dockerfile` installs `ca-certificates` in the
runtime stage and asserts that `/etc/ssl/certs/ca-certificates.crt` is nonempty.
Keep this package when changing the slim base image. Without it, the join
endpoint fails before returning the phone's token with
`engine: signal failure: transport connection error: IO error: no native root CA certificates found (errors: [])`.
The Android React Native transport uses JavaScript signaling and native WebRTC;
this error is returned from the server's bridge, not Android's TLS stack.
The exact empty-root error originates in
[tokio-tungstenite's Rust TLS connector](https://github.com/snapview/tokio-tungstenite/blob/v0.26.2/src/tls.rs#L90-L105).

Verify the built runtime, rather than a host with a preinstalled CA package:

```sh
docker build -f apps/server/Dockerfile -t beeline-voice-tls-proof .
docker run --rm \
  -v "$PWD/scripts/prove-voice-tls.mjs:/app/tls-proof.mjs:ro" \
  --entrypoint node beeline-voice-tls-proof /app/tls-proof.mjs
```

The proof uses an invalid JWT and requires a verified TLS connection reaching
LiveKit's HTTP 401, so it needs no secrets or existing Room. Supplying
`VOICE_TLS_CREDENTIALS` with short-lived JWTs scoped to a dedicated
`beeline-tls-proof-*` room also proves native audio publication and reception of
at least 100 Android microphone frames. Keep raw SDK output private: it can
contain those JWTs. [Android release proof](voice-mode-proof/android-tls-roots/README.md)
records the device, screenshots and media results.

The TLS fix requires a server release. The Room-agent strip shown during
connecting and error states is a JavaScript change delivered by mobile OTA.
Neither fix changes native inputs or runtime pins, so no new store build is
required.

Workers AI's free daily neuron allowance is insufficient for continuous voice.
At HTTP 429/code 4006, the voice bar displays the daily-limit message and
mutes the microphone; its pressed mic remains available to end the call. Flux
and Aura need a quota reset or a Workers Paid plan to resume.
Aura 2 and Flux both use Workers AI. Billing changes remain an owner decision.

## Isolated proof

[Multiparty release-emulator proof](voice-mode-proof/multiparty-fixes/README.md)
records named switching, full replies, unnamed-speech silence and one reply stream.

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

The multiparty regression proof, `scripts/prove-voice-multiparty.ts`, creates
another disposable in-memory Workspace and waits for a release emulator's second
human to Join through the actual call card. It uses live Flux, Luna and Aura 2,
checks both named agents, complete multi-sentence synthesis, silence for unnamed
speech, one concurrent reply stream and actual audio on both human clients.
Its scoped `session.json` and raw logs stay in `.voice-proof/multiparty/`;
release fixture files under `apps/mobile/.voice-proof/` use a local ignore file.

```sh
node --import tsx scripts/prove-voice-multiparty.ts
```

The earlier `VOICE_PROOF_COMPARE=1` runs below are historical provider measurements,
not the current provider selector. `VOICE_PROOF_LABEL` selects the ignored output
subdirectory for the earlier proof. `VOICE_PROOF_HOLD=1` retains the local server
for screenshots until SIGINT. Session files contain local proof tokens and must
never be committed.

Captured on 2026-10-13, three live Flux→Luna→speech turns per comparison:

| Transport / speech                 | End-of-turn to first server audio, ms | p50     |
| ---------------------------------- | ------------------------------------- | ------- |
| Local LiveKit / Aura-2             | 1870, 911, 930                        | 930 ms  |
| Local LiveKit / pinned Kokoro      | 4092, 3866, 1313                      | 3866 ms |
| Fly 256 MB LiveKit / Aura-2        | 1217, 1042, 1547                      | 1217 ms |
| Local LiveKit / Fish S2.1 Pro free | 1660, 1347, 1446                      | 1446 ms |

These are three-sample server measurements, not phone speaker measurements.
Fish used the same post-end-of-turn path with injected Flux EndOfTurn events,
because the real Flux endpoint still returned its exhausted daily quota. Its
actual Luna generation, licensed library voices, PCM synthesis and RTC playback
were live. The Fish full-flow proof also claimed an ordinary agent command,
created the greeting file and spoke its authenticated report to both humans.
Captured artifacts: [Aura-2](voice-mode-proof/aura-2.json),
[Kokoro](voice-mode-proof/kokoro-deepinfra.json),
[Fly transport](voice-mode-proof/fly-256mb.json),
[Fish full flow](voice-mode-proof/fish-s2-1-pro.json),
[Fish comparison](voice-mode-proof/fish-s2-1-pro-compare.json), and
[the earlier browser voice-bar capture](voice-mode-proof/room-voice-bar.png).
Both humans received actual audio; named targeting changed Ruby to Sol without
waking a real worker for conversation. External work was claimed, a file was
created, and its authenticated report was spoken. Browser proof exercised Join,
the 56 px voice bar, long press and mic exit. Mock acceptance is the approved
pass 08 board; the earlier browser capture used a minimal source-component
fixture, whose font-loading issue was corrected in the proof server.

**Pending by firstmate's delivery instruction:** real-phone first-audible-word
latency and the final phone comparison with the
approved frames. Cloudflare's exhausted free quota prevents a fresh live Flux
rerun tonight. Kokoro showed transient playback failures during the earlier
comparison; Kokoro and Fish did not meet the under-one-second target in these
server samples. Do not treat the table as an
under-one-second phone acceptance claim.

Regression coverage: `agent-voice.test.ts`, `voice-emotion.test.ts`,
`AgentVoiceSection.test.tsx`, `voice-profile.test.ts`, `voice-providers.test.ts`, `voice-room-runtime.test.ts`,
`voice-service.integration.test.ts`, `ConversationComposer.speech.test.tsx`,
and `chat-list-delta.test.ts`.
