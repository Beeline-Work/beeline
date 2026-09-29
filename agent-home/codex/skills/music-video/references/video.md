# Video: engine, scenes, the rules that keep it in sync

## Engine (`engine/`, Remotion 4, 1080×1920, 60 fps, CPU/SwiftShader WebGL)

Start a project: `cp -r engine <project>/video && cd <project>/video && cp -al
/home/alan/projects/testatlas-song/video-full/node_modules node_modules` (or `npm ci`),
(hard links only work on the same filesystem — not into /tmp; otherwise `npm ci`), put the song at `public/full.wav`, the timeline at `src/fullTimeline.json`.

- `TestAtlasFull.tsx` — the reference composition. Shot model: `{start, end, enter:
  'cut'|'flash'|'zoom'|'whip'|'slice'|'iris', render(t, s) → {w (env weights), heat, dim,
  shake, glitch, mono, layers[], bursts[], spec, words: {y,max}|null}}`. Transitions last
  `TR = 0.18 s`. `LyricLayer` draws the current word **above** transitions. `speed()` /
  `flowAt()` drive environment motion (slow in gaps, surge on hits). A `chorus()` factory
  locates each chorus from its own words and gaps. `export const SHOTS` for checkshots.
- `shader.ts` — 5 environment modes (river, night/stars, warp, topo contour flyover, rings)
  blended by weights. Re-skin by changing the 5–6 palette consts at the top (keep them dark
  → mid → accent → highlight). Keep the shockwave soft (~0.55) — bright palettes blow out.
- `theme.ts` — brand tokens `C` + fonts `F`; `loadFont` from `public/fonts`.
- `components.tsx` — `KineticWord` (brand words coloured via `isBrand`), `GlitchSplit`,
  `Streak`, `Phone`… `fx.tsx` — `Flash`, `LightLeaks`, `Stage3D`, `Orbiters`.
  `Particles.tsx` — embers/fireflies/bursts. `graphics2.tsx` — `NightClock`, `VaultLock`,
  `WordStorm(words)`, `Heartbeat`, …
- `atlas.tsx` — Test Atlas scene library (examples of lyric-driven graphics): AtlasMark
  (logo drawn node by node), Wordmark, LoopRing, FamilyMap (cue-able target + push-in),
  DrillCards, TrapChoices, TrapField, Rewind, ClimbChart, PatternSnap/Pulse/Crack,
  PassageStrike, ColdCoffee, HighlighterSwipe, BatteryDrain, PassageTunnel, LifeLine,
  FlatScore, PoisonWords, MatchLine, QuickCheck, FamilyBars, Receipt, MomChat, ShareBurst,
  EndCard. Beeline's library (Phone/review UI, GitMerge, HoneycombBuild…) lives in
  `/home/alan/projects/beeline-song/video/src/`.

## Scene design

- **One image per lyric phrase, cut on the phrase.** The user flagged 5–7 s of "just a
  clipboard with highlighter" — descriptive lyrics must each get their own visual (cold
  coffee → frosting mug; running on no rest → draining battery; life's on the line → heart
  monitor that flares red on LINE).
- **Every cue is keyed to a word (`w('WORD', from)`) or a measured hit** — never to a
  guessed offset. Scene changes on phrase starts, stamps/strikes/flips on the stressed word.
- **Music gaps are moments**: go dark and slow (env speed 0.06, beat pulses off) and let the
  vocal carry (the mark draws itself; the route traces "I know the way"); drop hard on the
  hit where the beat returns.
- Product truth: use the product's own UI vocabulary and mechanism; no fabricated metrics
  (bars/lines without numbers; "illustrative"); trademark line on the end card.
- Never reveal state before the lyric earns it (the receipt showed "FIXED" before "mistake
  fixed" — default such states to off and set them on the word).

## Rules that caught real bugs

1. **No cue inside an entry transition.** For zoom/whip/slice/iris enters, the first cue must
   be ≥ start + 0.18 s — start the scene 0.2 s before the word, or use 'cut'/'flash'.
   (Beeline's first swipe flew away hidden inside a slice.)
2. **Nothing under the lyric band.** Lyrics sit at y≈230–330. Clip scrolling/zooming layers
   with an OUTER wrapper `clipPath: inset(430px 0 0 0)` — a clip on the transformed layer
   scales with it. Cream text over cream pages is unreadable.
3. **Transitions under lyrics**: wipes/overlays render below `LyricLayer`.
4. **Scrolling traces**: put the write-head on screen (x≈760–800), not at the edge, or spikes
   read a beat late.
5. **Exposure**: check flashes, shocks, bursts on the new palette — the first Test Atlas
   render had white blobs on "GO" and the logo slam.
6. Run `checkshots.tsx` after every edit to the scene list (contiguity, lookups resolve).

## Look-dev

Before a long render, render 5–10 `npx remotion still` frames at the risky moments, or a
short range, and build a contact sheet (`ffmpeg ... tile=`); read it. Then a ~20 s
**sample from the full composition** (`scripts/render_sample.sh`) for user approval.
