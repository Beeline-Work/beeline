# Round six — one continuous Room, four pages

Review-only mock built on round five. Production `web/index.html` is unchanged. Rebuild with `python3 web/mock/round6/build.py` and preview at `/mock/round6/` on the existing static server.

The hero has a `100svh` minimum and can grow on phones to preserve a strict flow stack; the other sections occupy `100svh`: the hero, Bring your own agents, Everyone on the same page, and a closing download. CSS `y mandatory` scroll snap and a short landing settle keep one section dominant. Native keyboard/root scroll still works; the footer has an end snap target so scrolling can continue past the closing page. Reduced motion retains snap, removes the bounce and travelling/collapsing motion, and shows the final benefit graphics immediately.

The hero starts automatically and loops while visible. It has no playback button. Desktop has a 760px app window with a 168px workspace sidebar; phone retains a narrow transcript without the sidebar. The connector router, production palette and marketing typography remain. All avatar containers have fixed bounds and contained images/SVGs, including Hermes in the transcript and sidebar. Older entries are 75% opacity and only the latest entry is full opacity.

The composer inserts visitor messages directly into the conversation history. A hand-written response table matches named agents and simple keywords, adds two local banter replies, then resumes the script. New scripted turns append after those replies, so the visitor's message stays in its chronological position. Loops append the next story to a bounded 50-message history. Focusing/typing pauses the story; submitting resumes after the banter. Enter and the send arrow both work. All visitor and banter text uses `textContent`, not HTML.

Work graphics are illustrative HTML cards: X feed scanning, Codex files/diff/progress, Claude Code tests going green, and Hermes video render → Trusty Squire connection → YouTube/X post previews. No feed is queried, account connected, model called, post published or network API used. The exact one-prompt URL is still proposed and is not called.

The download CTA uses the existing `web/desktop-download.mjs` platform detector and original download URLs. It chooses iOS, Android, Mac, Windows or Linux and hides that platform from the Other platforms reveal. Unknown devices get a platform chooser. There is no Community link or download rail.

Each benefit has one headline and one line; the visual carries the story. Agent setup chips travel from an existing session to the Room. Separate private chats collapse into one Room with output, decisions and seen-by context. The subscription/AI-bill line describes the proposed existing-session story, not provider entitlement verification or Beeline pricing. Claude/ChatGPT plan compatibility must be confirmed before publishing that claim.

`window.r6Demo` exposes capture helpers: `seek(ms)`, `state()`, `pause()`, `play()` and the pure `responses(text)` table. `?still=1&at=24000` selects a fixed script frame without autoplay. Normal visitors get automatic looping and benefit animations triggered by actual section intersection. `window.r6DetectPlatform` is the unmodified production detector for browser checks.

The Lavish board retains desktop/phone story captures, public keyboard/link proof, reduced-motion evidence, and MP4/GIF sequences recorded through the headless browser and ffmpeg. No production publication or PR is authorized by this mock.


## Phone collision regression

The initial phone canvas scaled an absolutely positioned diagram but centered its unscaled height inside a shorter wrapper. It also sized the scene from `innerHeight` while the page used `100svh`. Browser toolbar differences could pull the avatars upward into downloads. The floating terminal separately overlapped the Room header.

The corrected phone scene reserves its own avatar bands around the transcript, stays in normal flow below the logo/tagline/download, and draws connectors from actual CSS rectangles. Phone sizing uses CSS small viewport units, not `innerHeight`. Its invitation is a full, visible transcript card inside the ledger; the desktop terminal is unchanged. The platform list expands in flow on phones. Script and stylesheet URLs carry a version so a real phone fetches the corrected layout.

Run the regression with the local static site already serving port 4388:

```sh
python3 web/mock/round6/tests/verify-phone-layout.py
```

The test runs real Chrome mobile emulation through chrome-devtools-axi at DPR 2.6 and touch enabled: 360×780, 390×844, 412×915 and 430×932. It checks 42 scene/transition samples at each size in two current-viewport states. A 112px [small/large viewport difference override](https://chromedevtools.github.io/devtools-protocol/tot/Emulation/#method-setSmallViewportHeightDifferenceOverride) simulates browser controls. The additional short viewport reserves another 112px to stress the fully expanded browser UI. Chrome clears its experimental toolbar override during navigation, so the runner reapplies it after each page load and asserts that measured `innerHeight - 100svh` is exactly 112px. Actual DPR, touch and avatar/terminal visibility are also required; these are not inferred from a desktop resize.

The rectangle check covers all visible hero HTML elements. It excludes only ancestor/descendant containment, decorative SVG connector paths, the scan line and screen-reader-only content. Wrapped inline fragments are measured separately, and scroll content is clipped to its actual ledger before testing. It also checks critical control bounds, image containment, avatar visibility, full inline-invitation visibility, no floating phone terminal, and absence of the external demo-video link. The baseline fails on the download/avatar and terminal/header collisions; the fixed layout passes.

`tests/mobile-mcp-adapter.mjs` is a worktree-local adapter for the installed upstream MCP emulation failure. It retains the AXI/Chrome MCP path and uses actual Chrome device-metrics, touch and viewport-height protocol overrides; it does not edit the installed tools or simulate geometry in the page. Set `CHROME_DEVTOOLS_AXI_UPSTREAM_MCP_ROOT` if the upstream package is installed outside the normal npx cache.
