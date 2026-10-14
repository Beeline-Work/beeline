# Conversation capture and playback proof

Source head: 324d951ea0cbbcc0ecfe8da5ec8616d379e6ee71.

Chrome replay on squire passed actual composer hold, authenticated join, browser Web Audio speech-fixture capture, real LiveKit transport, nonzero server microphone PCM, Ruby then Sol targeting from scripted STT finals, decoded reply audio and End cleanup. Squire captured 42,538 nonzero mic samples; reply peaks were 0.684 and 0.277, with advancing playback clocks. See squire-replay.json and chrome screenshots. Original independent Chrome/WebKit results from Chad are in result.json and WebKit screenshots. Local WebKit replay is blocked by missing libwoff2dec.so.1.0.2. No Tauri executable was run.

The hook, RTC, runtime and authenticated services are real. Physical microphone input is replaced by generated Web Audio speech; STT and brain responses are scripted, and output speech uses local Flite PCM. This does not prove acoustic recognition, live Flux/Luna/Aura or hardware speaker output. Autoplay is allowed in the Chrome fixture. End leaves one empty paused audio node with null srcObject, zero clock, ended capture tracks and closed server input.

## Repeat

Read conversation-proof.mts before running. Run from the repository root at the source head. Install Playwright 1.61.1 in a disposable directory; adjust its absolute import and the Chrome/WebKit executable paths in the copied harness to the local installation.

```sh
mkdir -p .voice-proof apps/mobile/.voice-proof/bbc
cp apps/mobile/evidence/desktop-voice-entry/conversation/conversation-proof.mts .voice-proof/
cp apps/mobile/evidence/desktop-voice-entry/conversation/*.wav apps/mobile/evidence/desktop-voice-entry/conversation/*.pcm .voice-proof/
cp apps/mobile/evidence/desktop-voice-entry/conversation/entry.tsx apps/mobile/.voice-proof/bbc/
docker run -d --rm --name conversation-proof --network host --memory 512m --cpus 2 livekit/livekit-server:v1.9.12@sha256:2c13cbf2edcbf13ea7b20d05c10b394d04d8fb3fe358269cff845a90b4de9576 --dev --bind 127.0.0.1 --node-ip 127.0.0.1 --config-body $'port: 17886\nrtc:\n  tcp_port: 17887\n  udp_port: 17888\n  use_external_ip: false\n  node_ip: 127.0.0.1\nlogging:\n  level: warn'
node --import tsx .voice-proof/conversation-proof.mts
docker stop conversation-proof
```

The harness writes per-engine status; process exit alone does not prove success. Require PASS fixture-provider integration, both names, nonzero decoded energy and cleanup. All identities, database, tokens and the LiveKit instance are disposable; no installed helper lifecycle is exercised.
