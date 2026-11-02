# Beeline Round 4 — Astra attempt 2

Direction: **A little more together.** An original animal-sticker ensemble on warm, full-screen color fields. One active speaker and message at a time; quiet participants recede.

Open `index.html` directly. It works offline; no server, external assets, account, or installation is required. Scroll through five chapters. Use Next moment, Invite your agent, and Next handoff to advance their stories; the small step buttons jump to a particular beat. Downloads are deliberate placeholders and explain that when clicked. No external action occurs.

## Main review frames

`frames/01-hero-{1440,390}.png`
`frames/02-context-{1440,390}.png`
`frames/03-bring-{1440,390}.png`
`frames/04-agents-{1440,390}.png`
`frames/05-features-{1440,390}.png`

Desktop is 1440×900; phone is 390×844. The other 22 PNGs show every intermediate beat, including the initial invitation, all three shared-context moments, each agent handoff, Trusty Squire connecting to YouTube, and the illustrative published-video result. There are 32 PNGs in total.

## Real components, bounded fixture

`RoomPreview.tsx` imports the repository's `LedgerEntry`, `IdentityMark`, and `ChannelHeaderTitle`; `room.bundle.js` is their offline browser build. `component-sources.json` records the source hashes. Native-service dependencies use the existing browser-proof shims, so this is a real rendering fixture with static props, not a connected app. Surrounding animal stickers are original SVG art; native transcript identities keep the actual component behavior.

Rebuild the fixture from the repository root:

```sh
node --import tsx .lavish/website-r4-astra-2/build-room.mjs
```

Capture all frames through the required Chrome CLI:

```sh
python3 .lavish/website-r4-astra-2/capture.py
```

The capture script uses its own `beeline-r4-astra2` browser session. It expects this page to be open in that session; the first open is:

```sh
CHROME_DEVTOOLS_AXI_SESSION=beeline-r4-astra2 chrome-devtools-axi open file:///home/lunchbox/.treehouse/buzzy-655f97/25/buzzy/.lavish/website-r4-astra-2/index.html
```

## Verification and scope

`validation.json` contains scene states and layout measurements for all 32 captures. `interaction-proof.txt` records Next, invite, final-video and download-placeholder behavior; `browser-console.txt` records the clean console.

Harness names are grounded in `apps/body/src/agent-command.ts` (`AUTO_DETECT_AGENT_KINDS`): Codex, Claude Code, Goose, Pi, Grok, Cursor, OpenCode. They were not executed. The requested single-prompt MCP join and session-preservation claim are an illustrative proposed flow, not integration-tested behavior. Hermes is a scripted participant, not an entry in the supported-harness list. Trusty Squire authentication and YouTube/X posting are illustrated and never run. Video artwork is a placeholder, not a playable asset. The shield S and generic play mark are placeholders, not official third-party logos. The actual Beeline mark is copied from the repository.

The supplied Option 2 story is adapted into individual focused beats; Alan's implementation request omits the product vocabulary the brief explicitly excludes. No production files were changed, no board was published, no tunnel was opened, and nothing was pushed.
