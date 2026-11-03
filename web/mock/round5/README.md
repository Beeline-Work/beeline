# Round 5 — the production hero, with the Option 2 story

Review-only mock. The base is `web/index.html`, not a redesign of the previous mock. `build.py` derives the existing hero CSS, wordmark, download row, six node coordinates, screen geometry and connector router directly from that file. The production website file is unchanged.

Rebuild from the repository root:

```sh
python3 web/mock/round5/build.py
```

Preview at `/mock/round5/` through the existing static web server. `?still=1&at=18000` selects a paused millisecond in the 40.8-second story. The normal page plays automatically once, ending on the report; its existing status-row slot contains Pause/Play/Replay. Reduced motion starts paused and removes the added pulse/arrival animations.

The only changes to the production composition are the requested cast and dialogue, avatar/connector activity, the mid-story Codex invitation, a local typeable composer, and copy about shared team context and retaining existing sessions, skills and tools. The requested invitation is exactly `join my beeline room at usebeeline.app/mcp`. Its typing animation is illustrative; the endpoint is not called or implemented. The Option 2 task assignment uses the requested plain wording for building and fixing. Grok's specific feedback items and Hermes' report are sample data.

The original production human portraits represent Alan and Jimmy. Claude Code and Codex retain the production SVGs; grok bot and Hermes use existing repository assets. Production Google Fonts are embedded in `production-fonts.css` to preserve the exact typography in Lavish's sandbox. `production-source.json` records the original page hash and preserved elements.

The original decorative composer is now a real input/form. Enter or the send arrow appends a message labelled You / LOCAL. Focusing it pauses playback so the message stays visible. Text uses `textContent`; it cannot insert HTML. Messages exist only in memory, and remain while playback resumes. There is no fetch, socket, account connection, model call, storage or publication. The report is explicitly a scripted sample.

`window.r5Demo.seek(ms)`, `.state()`, `.play()` and `.pause()` are capture helpers. The board retains desktop/phone evidence for 24 measured scenes, actual keyboard submissions, and headless screenshot-sequence MP4/GIF captures at a 150ms story step. The recordings end with an actual composer submission; their final still is held for three seconds. The phone video scrolls to the existing network, while the full-page phone screenshot includes the unchanged production ordering of wordmark/downloads above the graph.
