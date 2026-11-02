# Website mock, round 2

Review only. No PR or live marketing publication before mock approval.

Open `index.html?direction=a&option=1` through the static web server described in `../README.md`.

- Directions `a`, `b`, `c` change layout, composition and typography: current marketing, Bone editorial/serif exploration, and Obsidian workspace/Space Grotesk.
- Option `1` is a hardcoded Beebee/Luna/Alan onboarding sequence. The cards advance through a sample project, peer review and the next step. Repository and video choices have distinct sample-preview paths. Replay resets the sequence. Nothing is generated, posted, connected or provisioned.
- Option `2` is a people/agent graph with the six verbatim dialogue beats from the round-two task brief. Speaker/recipient emphasis, the corners state, Play/Pause, Next and Replay run locally. Automatic playback stops on the last requested action. Reduced motion starts paused.
- Screenshot controls: `still=1` pauses automatic advancement; `beat=0..3` selects onboarding state; `beat=0..5` selects animation state. Default is the first beat.
- Download order is Android, iOS, Linux, Mac, Windows; links and icons come from the existing website.
- The single join prompt preserves the requested copy exactly: `join my Beeline workspace at usebeeline.app/mcp`. This URL returned 404 during review on 2 November 2026, so the mock and board flag it as proposed. No adapter/endpoint has been implemented.
- The eight supported running-session harnesses come from `apps/body/src/session-join/agents.ts`: Claude Code, Codex, OpenCode, Pi, Antigravity, Gemini CLI, Hermes and ZCode. MCP clients are a separate surface. Cursor direct-session support is not claimed.

The logo uses the canonical mark geometry from `apps/mobile/sources/buzz/beeline-mark.json`. Grok/Claude/Codex assets and Space Grotesk are reused from `apps/server/assets/mcp`; the font license is beside the copied fonts. `assets/space-fonts.css` embeds the same font bytes so the opaque-origin Lavish sandbox can load them without a font CORS error.

The same Lavish session now serves `../../../.lavish/website-mock-33/board.html`. Its `site/round2/` directory is a copy of this preview. Original references and the first mock remain in `round1.html`; the round-two frame matrix and verification are in `round2/` beside it. Keep those preview copies synchronized when revising.

Validation: twelve viewport cases (three directions × two heroes × desktop 1440 and phone 390) have no horizontal page overflow. Browser checks cover onboarding card advancement and separate video path, graph auto-advance/pause/next/replay, exact dialogue, the five download labels and the eight harnesses. The same public tunnel/session loads the board and assets at 390px.
