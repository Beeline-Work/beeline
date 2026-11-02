# Beeline website review mock

This is a review-only static preview, not the shipping homepage. `web/index.html` remains the current site. The review gate is mock approval; do not open a PR or publish this as the marketing site before approval.

Run from the repository root:

```sh
python3 -m http.server 4388 --bind 127.0.0.1 --directory web
```

Open `http://127.0.0.1:4388/mock/`. The home, comparison sample and scripted Room work as static pages. No build, sign-in, production socket, backend call or model invocation is required. Google Fonts are the only remote dependencies.

- `index.html`, `style.css`, `mock.js`: home, responsive people/agent/Room graph and agent-specific connection prompt.
- `demo.html`: sandboxed scripted Room, reusing the existing marketing transcript styles and identity SVGs from `web/index.html`. This is not the production React Native Ledger component. It accepts @codex and @claude, replies locally, bounds history, and resets with Replay.
- `compare.html`: sample comparison layout with dated first-party sources and explicit limits on unverified claims.
- `../../.lavish/website-mock-33/board.html`: review board, benchmark captures and eight proposed editorial titles. Its `site/` directory is a portable copy of this preview plus the board's small CTA interaction frame. Recopy modified mock files there when revising the board.

The prompt follows the existing authoritative guides in `web/room/index.html` and `web/connect/index.html`. Cursor direct-session support is explicitly unverified. Do not replace that state with a made-up command.

Benchmark: public OpenBot home, expanded navigation, `/compare/openclaw`, `/guides/install-openbot-vps`, and the public Beeline home. Captured 2 November 2026 using chrome-devtools-axi at 1440 × 1000 and 390 × 844. OpenBot assets appear only in reference screenshots, never in the Beeline mock.

Validation: browser inspection at both widths; no home horizontal overflow; local @mention response; Replay during a pending response followed by another message; Codex/ChatGPT/Cursor CTA states; JavaScript syntax check; public Cloudflare tunnel and Lavish assets loaded at 390px. This mock changes no server, mobile app, onboarding adapter or live site behavior.
