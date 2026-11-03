# Round six — one continuous Room, four pages

Review-only mock built on round five. Production `web/index.html` is unchanged. Rebuild with `python3 web/mock/round6/build.py` and preview at `/mock/round6/` on the existing static server.

Four sections each occupy `100svh`: the hero, Bring your own agents, Everyone on the same page, and a closing download. CSS `y mandatory` scroll snap and a short landing settle keep one section dominant. Native keyboard/root scroll still works; the footer has an end snap target so scrolling can continue past the closing page. Reduced motion retains snap, removes the bounce and travelling/collapsing motion, and shows the final benefit graphics immediately.

The hero starts automatically and loops while visible. It has no playback button. Desktop has a 760px app window with a 168px workspace sidebar; phone retains a narrow transcript without the sidebar. The connector router, production palette and marketing typography remain. All avatar containers have fixed bounds and contained images/SVGs, including Hermes in the transcript and sidebar. Older entries are 75% opacity and only the latest entry is full opacity.

The composer inserts visitor messages directly into the conversation history. A hand-written response table matches named agents and simple keywords, adds two local banter replies, then resumes the script. New scripted turns append after those replies, so the visitor's message stays in its chronological position. Loops append the next story to a bounded 50-message history. Focusing/typing pauses the story; submitting resumes after the banter. Enter and the send arrow both work. All visitor and banter text uses `textContent`, not HTML.

Work graphics are illustrative HTML cards: X feed scanning, Codex files/diff/progress, Claude Code tests going green, and Hermes video render → Trusty Squire connection → YouTube/X post previews. No feed is queried, account connected, model called, post published or network API used. The exact one-prompt URL is still proposed and is not called.

The download CTA uses the existing `web/desktop-download.mjs` platform detector and original download URLs. It chooses iOS, Android, Mac, Windows or Linux and hides that platform from the Other platforms reveal. Unknown devices get a platform chooser. There is no Community link or download rail.

Each benefit has one headline and one line; the visual carries the story. Agent setup chips travel from an existing session to the Room. Separate private chats collapse into one Room with output, decisions and seen-by context. The subscription/AI-bill line describes the proposed existing-session story, not provider entitlement verification or Beeline pricing. Claude/ChatGPT plan compatibility must be confirmed before publishing that claim.

`window.r6Demo` exposes capture helpers: `seek(ms)`, `state()`, `pause()`, `play()` and the pure `responses(text)` table. `?still=1&at=24000` selects a fixed script frame without autoplay. Normal visitors get automatic looping and benefit animations triggered by actual section intersection. `window.r6DetectPlatform` is the unmodified production detector for browser checks.

The Lavish board retains desktop/phone story captures, public keyboard/link proof, reduced-motion evidence, and MP4/GIF sequences recorded through the headless browser and ffmpeg. No production publication or PR is authorized by this mock.
