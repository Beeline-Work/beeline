# Round 3 — a real Room at the center

Review-only Option 2. Existing Option 1 files and flows are unchanged.

Preview through the web server at `/mock/round3/`. Automatic playback has thirteen local phases. `?frame=0..12&still=1` selects a stable frame. Pause, Next and Replay are local controls. Reduced motion starts paused.

The Room imports these unmodified application components:

- `LedgerEntry` — production transcript prose, bylines and mentions.
- `IdentityMark` — production animal marks and agent working ring; fixture identities have explicit faces.
- `ChannelHeaderTitle` — the shared Room title.
- `ConversationComposer` — the real shared composer, with speech disabled in the fixture.
- `TranscriptCard` — Grok's sample feedback and Hermes' illustrative report.
- `RepositoryLifecycleRow` — Codex and Claude Code's corner records.

The desktop composition includes a fixture workspace rail. The phone composition uses a phone-width Room without the desktop rail. Both use the same actual shared components. This is an offline fixture shell, not a signed-in full application route.

Rebuild from the repository root:

```sh
node --import tsx web/mock/round3/build-room.mjs
```

The build reuses `webProofShims` from the existing mobile browser-proof harness for device services and theme access. Additional shims disable speech, external navigation and unused code-block rendering. Rendered transcript, card, title, identity and composer components stay real. The source paths and SHA-256 hashes are in `component-sources.json`. `fonts.css` embeds the existing app font bytes to work in Lavish's opaque-origin sandbox.

The six spoken lines come verbatim from round two's `script-data.js`. The additional sample card values are illustrative mock data. The report says that nothing was posted. No production Room, live socket, API credentials, model call, lifecycle operation, HTTP polling or external publishing is used.

`../../../.lavish/website-mock-33/round3/` contains seven captured moments at each viewport, a standalone sequence player and the browser proof JSON. The same review board retains previous directions and Option 1. Every full-page and working-page URL is also listed as a plain absolute link at the board top. Links use an explicit action marker and same-frame navigation; a 390px Chrome tap through the public tunnel was verified.
