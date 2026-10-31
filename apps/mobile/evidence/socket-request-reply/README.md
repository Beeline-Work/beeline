R1 uses the built phone operation client and Room view client against the built server, a real authenticated WebSocket, and an isolated PGlite database. The service deliberately leaves phone HTTP requests unanswered.

Run from the repository root:

```sh
npm run prove:phone-socket-r1 -- --baseline-ref a5da6eade
```

Before the migration, opening the Room sends HTTP and fails at its existing deadline (15 seconds). After the migration, Room open/refresh, history, Workspace/chat lists, a read mark, and repeated sends succeed through one live socket. The refreshed server view contains one copy of the sent text. The chat list stays gated until the Room draw barrier releases. No migrated request reaches HTTP. `R1.json` records the result; temporary bundles and the fresh result stay under `.beeline-proof/phone-socket-r1`.

The emulator was attempted with `beeline emulator -avd dmproof -no-window -gpu swiftshader_indirect`. It exited before boot because this session cannot open `/dev/kvm`. This stand-in proves the phone transport and returned Room text, not native painting, radio behavior, push delivery or a production release. React Native lifecycle, platform storage and trace sinks are host seams; operation dispatch, DTO guards, request correlation, socket authentication and database reads/writes are real.

Focused tests additionally cover reversed/duplicate/unknown replies, malformed replies, in-flight limits, UTF-8 frame limits, cancellation, disconnect/identity cleanup, authorization/deadline failure, Room-draw ordering and the unchanged vault card HTTP submission. The existing channel guard tests reject injected `fetch(` and `new WebSocket(` calls, including aliases. The inventory contains only the main socket, exceptions and links.
