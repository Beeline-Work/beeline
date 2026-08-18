# Corner fidelity — grok Build motion evidence

Captured firsthand by driving `grok --always-approve` (Grok Build 1.0.4) against a bugged
Python fixture in a 150×45 tmux pane, recording every repaint with `tmux capture-pane -e`
(SGR preserved) at 40–120ms and de-duplicating identical frames. 565 distinct frames across
three turns: a fix-the-bug turn, a research-only turn, and a deep read-only sweep.

The `.ansi` files keep their original SGR codes — `cat` one in a 150-column terminal to see
grok's real rendering. The PNGs are those frames rendered to HTML and screenshotted.

| File | What it shows |
|---|---|
| `grok-motion-contract.png` | All five beats, annotated with their measured timestamps |
| `corner-emulation.png` | grok's frames beside the corner rows at Beeline's real tokens |
| `grok-reasoning-loud.ansi` | Reasoning streaming multi-line under a thick `┃` rail (t=2883ms) |
| `grok-reasoning-quiet.ansi` | Collapsed to `◆ Thought for 5.8s` in the same frame narration begins (t=16909ms) |
| `grok-inflight-count.ansi` | The status line's running verb+count, `⠹ Preparing grep (6)…` (t=5569ms) |
| `grok-rollup-live.ansi` | The rollup arriving whole, present participle, thick rail (t=7498ms) |
| `grok-rollup-settled.ansi` | The same row 104ms later: past tense, thin rail (t=7602ms) |

## Measured numbers this branch is calibrated against

- **Narration streams; rollups pop.** Narration grew 5–9 words per repaint at ~130ms.
  The rollup row appeared complete in a single frame and never grew in place.
- **Live → settled demote: 52–104ms** (7498→7602ms, and 11199→11251ms). Tense, luminance,
  and rail weight all demote together.
- **In-flight count ticks every ~50–110ms** — `read_file` → `(2)` → `grep (3)` → `(4)` →
  `(5)` → `grep (6)` → `list_dir (7)` → `run_terminal_command (8)` → `use_tool (9)`.
  The count resets per group.
- **Reasoning collapses on the answer, not on a timer.** In all three turns the
  `Thought for Xs` receipt and the narration's first phrase landed in the same frame.
- **Spinner cycle ≈ 1.0–1.5s** (10 braille frames, 101–182ms each). `motionTokens.liveCycle`
  was already 1120ms and needed no change.
