# Production marketing page

`web/index.html` serves `usebeeline.app` through the existing Pages build (`scripts/pages-site.mjs`). `web.usebeeline.app` is the separate Expo application. Review-only `web/mock/` pages are excluded from Pages output.

The page preserves the approved round-seven shell. Its UI is exported from the actual shared `apps/mobile` components at build time (`provenance.json` records the source hashes). Production ships their HTML/CSS and a dependency-free DOM controller; React, React Native Web, device integrations and the mock's 1.7MB bundle never load. Fonts are local WOFF2 subsets with their original licenses. The first hero message and download destinations are server-readable HTML; `boot.mjs` detects the platform, routes the graph, then lazy-loads the interactive demo on idle or interaction.

Edit `demo-source.mjs`, then run `node scripts/marketing/build.mjs`. The hand-written script and response table are in `story.mjs`; neither composer uses a model, backend API, socket, storage or polling. User text enters through text nodes. Histories are capped at 50 messages. Existing download attribution is retained separately and runs on download clicks, not demo messages.

To intentionally regenerate the shared UI, install the mobile development dependencies, rebuild only `web/mock/round7/build-room.mjs`, serve `web/` on port4388, and run `python3 scripts/marketing/export-ui.py`. The archived round-seven HTML is the frozen approved shell; do not run its legacy `build.py` against the new production homepage. `scripts/marketing/build.py` regenerates the production HTML, CSS, geometry and font assets from that shell and UI export; it requires FontTools and Brotli in a worktree-local Python environment. Then rebuild the controller. Regenerated markup should be reviewed with fresh frames.

Reduced motion shows a settled transcript and connected terminal state without autoplay or CSS motion. Normal motion loops only in the section the visitor is viewing; focus/typing takes control of the terminal. Leaving and returning restarts its demo. Tool disclosures use the exported app rows and a native web dialog with Escape/backdrop dismissal and copy output. Download links use the existing `desktop-download.mjs` detector and stable app-store/release destinations.

Verification with the static server on port4388:

```sh
node --test scripts/landing-animation.test.mjs scripts/desktop-download.test.mjs scripts/x-attribution.test.mjs scripts/pages-site.test.mjs
python3 scripts/marketing/verify-phone-layout.py
python3 scripts/marketing/verify-browser.py
python3 scripts/marketing/verify-autoplay.py
```

The browser checks use chrome-devtools-axi. The task-local Lighthouse adapter uses the full official Lighthouse SDK, because the MCP's bundled build replaces paint/timing audits with shims. Install the audit-only tool with `npm install --prefix .scratch/full-lighthouse --no-save lighthouse`. The adapter reuses AXI's Puppeteer page and does not change the audited page or installed tools. Run its session with `CHROME_DEVTOOLS_AXI_MCP_PATH` pointing to `scripts/marketing/lighthouse-adapter.mjs`, then `chrome-devtools-axi lighthouse --device mobile`.
