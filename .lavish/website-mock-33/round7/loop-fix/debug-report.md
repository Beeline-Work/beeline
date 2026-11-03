# Round 7 autoplay stall — fixed

Symptom: At 412×860 in real Chrome, `window.scrollBy(0, innerHeight)` reached the Bring your own agents page. After 31 seconds the exact join prompt remained in the input, Jimmy was the only Room message, and Codex had not joined.

Root cause: The previous effect only called `setValue` while typing. It never submitted the prompt, scheduled a task, mirrored later messages, or scheduled another cycle. A permanent `started` flag prevented replay. Its 70% whole-section intersection threshold also depended on section/viewport geometry rather than which section the visitor was reading.

Fix: `web/mock/round7/RoomPreview.tsx` now runs a bounded local sequence: type/submit the exact join instruction → type/submit a task → share the result and Jimmy/Claude messages → send a Room message into the terminal → repeat. Scroll, resize, initial layout, page-show and hash events check whether this section owns the viewport center. Page visibility is handled synchronously, including when animation frames are suspended. Leaving cancels pending automatic actions; returning starts a fresh cycle. Actual input focus/typing takes control so the demonstration cannot overwrite the visitor's work. Joined-state and action refs prevent stale timer closures. No network, model, socket or polling is introduced.

Identity fix: Codex's rail, sidebar and other outer marks now render the same unmodified shared `IdentityMark` as its transcript: the same `codex` seed, cat face and working state. The face path data matches exactly. Other identities, page structure, palette, typography and transcript components are unchanged.

Regression: `web/mock/round7/tests/verify-autoplay.py`. The published pre-fix build fails the same 31-second assertion (`autoplay-baseline.json`). The fixed build passes real resized-Chrome scrollBy, native CDP wheel, native touch swipe, PageDown and direct `#bring` navigation. Every route completes repeated join/work/two-way-message cycles without calling playback helpers. The exact scrollBy case also verifies leaving and returning. Native gestures go through a worktree-local chrome-devtools-axi MCP adapter; installed tools are unchanged.

Additional checks: native keyboard interaction in both panes, native tool output, refreshed hero screenshots at 1440/360/390/412/430, and 336 phone story/transition samples pass. The shared identity graphic is treated atomically in the overlap check: its face SVG must fit its tile; its intentional native working ring sits outside that plate as specified by IdentityMark. No avatar is hidden to pass the check.

Evidence: `autoplay-proof.json`, `reentry-proof.json`, `identity-proof.json`, `final-autoplay-test.log`, `manual-test.log`, `phone-test.log`, and the exact public reproduction at 412×860 in `public-reproduction.json`.

Status: DONE. Mock-only follow-up; no production app changes or publication of agent work.
