# Round seven — shared app UI and two control panes

Review-only source. Production `web/index.html` and `apps/mobile` are unchanged. Rebuild:

```sh
python3 web/mock/round7/build.py
node --experimental-strip-types web/mock/round7/build-room.mjs
```

Serve `web/` locally on port 4388 and open `/mock/round7/`. This mock preserves the production marketing palette, fonts, download detector and graph router. The canonical mark's SVG viewBox is cropped to its actual ink bounds; the visible mark is .73em high beside the wordmark. The phone wordmark is 30px, tagline 12px on one line, download 34px high. The strict-flow phone canvas allocates the recovered space to the transcript, with no scaling transform.

All three shared Rooms are React renderings of unmodified `apps/mobile` components. The wrappers in `room.css` only allocate the page/header/scroll/composer stack; they never replace the components' typography, colors, cards or rows. Their actual Obsidian theme is supplied by the repository's browser-proof service shim (`apps/mobile/sources/test/browserProof.ts`). App fonts and the real Ionicons font are packaged locally. `build-room.mjs` records SHA256 for the visible component implementations in `component-sources.json`.

| Visible element | Authoritative implementation |
|---|---|
| Room title | `ChannelHeaderTitle.tsx` |
| Human and agent message, mention, face tile | `Ledger.tsx` → `LedgerEntry`, `IdentityMark.tsx`, `MonoMarkdown.tsx` |
| Quiet date/local-demo line | `Ledger.tsx` → `LedgerHistoryLine` |
| Agent joins | `Ledger.tsx` → `LedgerSystemLine` |
| Feedback/report facts | `TranscriptCard.tsx` |
| Agent work item / check result | `PrLifecycleCard.tsx` → `RepositoryLifecycleRow` |
| Expandable tool steps | `ActivityTimeline.tsx` → `TurnStepsLine`, `LedgerDisclosure.tsx`, `IndexRow.tsx` |
| Tool result opened from a step | `ToolOutputSheet.tsx`, `CodeHighlighter.tsx` |
| Working mark and line | `TurnProgressLine.tsx` → `TurnProgressLine`, `TurnBandSlot`, `BeelineMarkSpinner.tsx` |
| Message field, attachment affordance, send arrow | `ConversationComposer.tsx` |

Paths above are relative to `apps/mobile/sources/components/buzz/`. Device services (speech, routing, telemetry, clipboard) are inert; visible components are real. The unused markdown CodeBlock integration is shimmed out, while tool output uses the actual CodeHighlighter. Attachment is disabled because the sample has no upload backend. Fixture identities have explicit, stable animal faces, as real IdentityMark expects. Outer graph provider marks and the marketing workspace sidebar are marketing chrome; they are not claimed as shared app components. The BEFORE private-chat boxes are a conceptual diagram; the AFTER Room uses shared UI.

The Codex control pane follows the [official Codex CLI terminal layout](https://learn.chatgpt.com/docs/codex/cli): header box with model and directory, transcript, `›` prompt, and context/shortcut footer. The displayed model, project, messages, tools and context count are fixture values. This is an interactive browser simulation, not a running Codex process. The full join instruction is exactly `join my beeline room at usebeeline.app/mcp`. It stays local and is never fetched or executed. Press Enter to join, then enter a task. That task appears as Codex working in the adjacent shared Room, with real tool/check components. Jimmy and Claude's messages appear in both panes. Sending from the Room's actual composer also appears in the terminal and receives a local scripted reply. No extra product buttons were introduced.

`window.r7Demo` exposes seek/play/pause/state for the looping hero; `window.r7Sync` exposes local sendTerminal/sendRoom/state for deterministic captures. `?still=1&at=22500` disables autoplay. Normal visitors see the exact prompt type into the terminal on first landing, then press Enter themselves. The terminal and Room remain usable. All replies are hand-written, not model output. No polling, model requests, sockets, storage, production Room, real files or publication are involved.

Verification (run sequentially for predictable browser capture):

```sh
python3 web/mock/round7/tests/verify-phone-layout.py
python3 web/mock/round7/tests/verify-interaction.py
python3 web/mock/round7/tests/capture-review.py
```

The phone regression runs 42 story/transition samples at 360/390/412/430 widths and two toolbar states, with genuine Chrome mobile metrics (DPR 2.6, touch 5, measured 112px small/large viewport difference). It checks critical control and avatar bounds, painted text/control overlaps, scroll clipping, SVG/image containment, no horizontal overflow, and no floating terminal. The Room wrapper follows native content/viewport resizes and reserves the app’s canonical 42px bottom gap directly from `buzz/room-bottom-chrome.ts` (`TURN_LINE_ROW_MIN_HEIGHT + COMPOSER_TOP_GAP`). That same gap exists before the live line mounts, so native layout measurement cannot briefly cover the newest text. Empty React Native layout wrappers are not painted content; native progress coverage occupies the composer's own reserved margin. No avatar is excluded to make it pass. The test captures actual app glyph/text leaves and interactive controls. Desktop and sync proofs are also captured and checked at the requested widths. Screenshots use CSS-pixel output; emulated DPR is recorded separately.

The benchmark, comparison layout and SEO titles remain on the archived round-one board, linked from the current board. Competitor claims and proposal caveats remain there. This is mock approval only; no push or PR.

Native keyboard proof deliberately focuses via a stable DOM selector and uses AXI `type` / `press Enter`, as firstmate directed; animation does not invalidate selectors as it can accessibility references. Tool disclosures are focused by their real accessibility roles and activated with Enter. These scripts never invoke the application callbacks to simulate a visitor action.
