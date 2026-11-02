# In good company — Round 4 / independent Astra direction 1

Open `index.html` directly from disk. No server, external fonts, accounts, APIs or network connection are needed.

Five viewport-sized chapters use cream, obsidian and brass, oversized editorial type, and the real Beeline animal identity marks. Scroll to change chapters; Next, Previous and Replay change the active story beat. There is no automatic playback or scroll hijacking. Motion respects `prefers-reduced-motion`.

## Review entry points

- `index.html`: hero, then the full five-section story.
- `index.html?section=2&beat=2`: Jimmy joins the conversation from his phone.
- `index.html?section=3&beat=0`: the existing Codex session and the requested prompt.
- `index.html?section=3&beat=1`: the same agent arrives with its tools, skills and project.
- `index.html?section=4&beat=7`: Hermes uses Trusty Squire to connect to YouTube.
- `index.html?section=4&beat=8`: the illustrative video and real TranscriptCard report.

The download buttons only show a local preview notification. The terminal, Room shell, network and service-connection illustration are fixture compositions. No app is launched and nothing is connected or published.

## Real product UI

`RoomPreview.tsx` imports unmodified production `LedgerEntry`, `IdentityMark`, `ChannelHeaderTitle` and `TranscriptCard`. `component-sources.json` records the exact source hashes. The bundle uses the repository's `webProofShims` for device/theme dependencies; the actual rendered components remain real. The Room composer is a subdued decorative shell, not a functioning app composer.

Rebuild from the repository root:

```sh
node --import tsx .lavish/website-r4-astra-1/build-room.mjs
```

`fonts.css` embeds Space Grotesk and IBM Plex Mono. Bricolage Grotesque comes from the existing repository font asset in `assets/display.ttf`. The Beeline mark is the existing project mark. No real third-party logos are included: the Trusty Squire knight and YouTube play tile are placeholders; Codex, Claude Code and Hermes use Beeline animal identities.

## Captures and evidence

`frames/` contains 32 PNGs: all five chapters and every interactive beat at 1440×900 and 390×844. `validation.json` records each frame's viewport, section dimensions, active network nodes/edges and report/control positions. `interaction-checks.json` records the keyboard/click checks. `console.txt` and `network.txt` are browser evidence. `capture.py` reproduces the screenshots using an isolated named `chrome-devtools-axi` session.

## Scope and verification limits

The eight harness names are the exact list in `apps/body/src/session-join/agents.ts` (AGENTS and LABELS): Claude Code, Codex, OpenCode, Pi, Antigravity, Gemini CLI, Hermes and ZCode. These adapters were verified in source, not exercised. The exact requested `usebeeline.app/mcp` one-prompt flow remains unverified and is labelled on the page.

The Option 2 dialogue is retained through the request, research and team decision. The implementation instruction is adapted to avoid the retired website terminology, individual Codex/Claude acknowledgments make the work legible, and the Trusty Squire connection/video outcome are illustrative additions. Nothing here claims a real account connection or video publication. The preview is intentionally deterministic and stops on each beat.
