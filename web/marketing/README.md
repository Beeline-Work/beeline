# Marketing homepage

`web/index.html` serves `usebeeline.app` through `scripts/pages-site.mjs`. The Expo application at `web.usebeeline.app` is separate.

Edit the HTML, CSS and modules in this directory directly. `ui.json` contains the shared mobile component markup used by the scripted demo; `provenance.json` points to its original components and hashes. This is a static export: mobile component changes do not automatically update the marketing page. The page uses local WOFF2 fonts and includes their licenses.

The single build step uses the repo's existing esbuild dependency:

```sh
node scripts/marketing/build.mjs
```

Run it after changing `demo-source.mjs`, `story.mjs` or `ui.json`, and commit the generated `demo.js`. The browser lazy-loads this dependency-free controller; it never loads React or React Native Web. The hero's first message and platform download destinations are present before JavaScript runs.

The hero and join-demo composers use the deterministic response table in `story.mjs`, with no model, backend, socket, polling or storage. User messages enter through text nodes; histories are capped at 50 messages. Existing download attribution runs separately on download clicks. Normal-motion playback follows the visible section and stops for manual terminal interaction. Reduced motion shows a settled transcript and connected terminal without autoplay.

Run the targeted JS checks:

```sh
node --test scripts/landing-animation.test.mjs scripts/desktop-download.test.mjs scripts/x-attribution.test.mjs scripts/pages-site.test.mjs
```

For visual changes, serve `web/` and check 1440px desktop and 360/390/412/430px phones, keyboard send, tool disclosures, the download chooser and reduced motion. Review screenshots and the original full Lighthouse reports are linked in the PR body rather than committed as production assets.

The same-page artwork in `context-art.mjs` moves seven assigned tasks along a center rail, with two or three in focus. `boot.mjs` imports this controller so the runtime and dead-code graph share the same entry. Complete output lines fade as a unit. It runs only in the visible section and freezes under reduced motion. `identities.css` and `logos/provenance.json` own the local company marks and native person avatars. The join-demo Room starts without Codex: a human types the CLI prompt, then the exported system line precedes Claude’s welcome.
