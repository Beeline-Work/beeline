# Round 4 — one section, one story

Review-only directions A and B. Open `index.html?direction=a` or `index.html?direction=b` through the existing static web server. Each page has five full-height story sections: introduction, shared context, existing-session invitation, agent collaboration and short features.

A follows Beeline's Space Grotesk / Obsidian language and uses real product identity marks. B uses original round animal SVG characters, small sticker reactions and the existing Bone palette. No KakaoTalk assets or characters are copied. B's promotional character portraits are a marketing concept; no production profile or avatar behavior changes.

Both pages render actual `LedgerEntry`, `TranscriptCard` and `ChannelHeaderTitle` components; A also uses actual `IdentityMark` portraits. Device services and unused native integrations use the existing browser-proof shims. The source hashes are in `component-sources.json`.

Rebuild from the repository root:

```sh
node --import tsx web/mock/round4/build.mjs
```

Stories advance with explicit buttons. An IntersectionObserver keeps only one section current; inactive sections and story elements dim or blur. The context story has three messages, including Jimmy's phone view. The invitation has four beats: existing session/prompt, joining, carrying tools/skills/setup, and arrival in the shared Room. The collaboration has eleven beats and gives Trusty Squire → YouTube a separate connection action before the simulated video post and report.

The prompt is exactly `join my Beeline workspace at usebeeline.app/mcp`. That URL remains a proposed flow (404 during review); no live join is attempted. The eight running-session harness names are sourced from `apps/body/src/session-join/agents.ts`. Third-party services use placeholder marks. Beeline's own mark is the canonical project asset.

Everything is an offline fixture. Native Connect/Share actions change local story state only. No account connection, publication, model call, live socket, lifecycle operation or backend polling occurs. The report is marked as a scripted outcome. The removed website terminology is absent from visible copy.

For capture only, `window.setR4Story(section, beat)` selects a stable moment; `window.r4State()` reports it. Normal visitors use the page controls and scroll.

The Lavish board at `../../../.lavish/website-mock-33/board.html` compares these with C/D, copied unchanged from the preserved Astra handoffs. Their original-file hashes are recorded in `round4/scout-copy-manifest.json`. Additional `portable.html` entry files package local fonts for Lavish's opaque-origin sandbox; copied original files are not edited. The prior board is retained as `round3-board.html`.

Verification: forty A/B section/beat captures at 1440px and 390px, plus the prompt frames; no horizontal overflow, no unexpected dialogs, and one current section. The actual native Connect YouTube and Share actions were exercised and reached the local connected/post-report states. All five sections are present for every direction, including the scouts' own 32-frame evidence each.
