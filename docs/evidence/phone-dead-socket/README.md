# Phone dead socket — Reproduction R1

Android API 35 emulator (`se_api35`, leased `emulator-5554`), Expo Go SDK 55. The proof mounts the production native Room route, Room session, transcript and LiveConnection. Existing offline-proof adapters replace authentication, storage, theme and unavailable native integrations. A local HTTP fixture supplies a Room with a seeded working agent turn, then stores its final reply and completed turn. This is not a live model run, a signed production session, or a release APK. It proves the native client failure mechanism; it cannot establish that the historical incident had no other cause.

`apps/mobile/dead-socket-proof/server.cjs` forwards WebSocket traffic through a TCP proxy. `/drop` discards traffic on existing connections without FIN/RST, then commits the final reply and completion and attempts both live deltas. HTTP remains healthy, and new socket connections still work. No server heartbeat is enabled. The proof uses the same 13-byte `{"type":"ping"}` / pong exchange already supported by the production server.

## Before

Baseline: `64f777dd3`; only the eight-second Room reload is disabled so it cannot mask the transport failure.

1. Open the Room with the seeded agent working. One subscription and one HTTP Room read succeed (`before-open.png`).
2. Black-hole the established path. The fixture commits the final reply at `1792343164942` ms.
3. After 28 seconds, the reply is absent and the native working line is still visible (`before-stale.png`). `before-stale.json` still has one Room read and the same open, black-holed proxy path. No close/error or replacement connection occurred.
4. Tap the proof's **Next send (covering Room read)** control. This explicitly remounts the Room session to stand in for the user's next covering read; it does not publish a real message. The second GET reveals the final reply and removes Working (`before-next-read.png`).

Reproduction R1: open Room, agent working, path silently dropped → final reply and finished state never appear until next covering read.

## After

The same native route and fixture use the fixed transport and Room session.

- Socket open: `1792343361726` ms; final reply committed behind the drop at `1792343375116` ms.
- New connection: `1792343392327` ms, **17.2 seconds after the drop**, within the remaining ping interval plus its ten-second timeout.
- Exactly one recovery Room GET: `1792343393328` ms. Native `room-read-end` at 13:09:53.898, followed by `fresh-apply` and layout, shows the final reply and completed turn. `after-recovered.png` captures the visible result without a send.
- `background.json` records a 52.7-second native background interval with no ping frames (only the existing viewing-release frame).
- `after-idle.json` records the same two Room GETs after further healthy ping exchanges: one opening read and one recovery read, with no full-Room polling.

`live-connection.test.ts` includes a 30-second silent-socket replacement regression. Running that test against the original transport fails because the socket remains open (`regression-before.txt`). It passes with the fix. Additional coverage checks a nine-second response, ping cost, background cancellation, replacement backoff and a fresh subscription without an old cursor. The Room-session tests retain failed-read retries and assert that working Rooms never poll.

## Run again

From the repository root, after `npm run corner:prepare`:

```sh
npm install --prefix apps/mobile/dead-socket-proof --legacy-peer-deps
node apps/mobile/dead-socket-proof/prepare-baseline.cjs
node apps/mobile/dead-socket-proof/server.cjs
```

In separate terminals:

```sh
beeline emulator -avd se_api35 -no-window -gpu swiftshader_indirect
cd apps/mobile/dead-socket-proof
SOCKET_PROOF_BASELINE=1 CI=1 ../node_modules/.bin/expo start --go --port 8199 --max-workers 2
```

Install Expo Go SDK 55 on the leased device, reverse `tcp:8199`, and open `exp://127.0.0.1:8199`. Wait for the working Room, then request `http://localhost:8896/drop`. Inspect the screen and `/status`. Tap the proof control to demonstrate the covering read. For after, restart the fixture, omit `SOCKET_PROOF_BASELINE=1`, restart Metro, and relaunch the app; repeat the drop and wait for automatic recovery.

Validation: root `npm run typecheck`; 136 mobile transport/session tests. No server behavior or background/push flow changes.
