#!/usr/bin/env node
/**
 * Does the newest message hold its place when the phone thinking band appears
 * and goes?
 *
 * The defect is a TRANSITION, so a number read off a style object cannot show
 * it: the question is where the last row is painted before, during and after
 * the band, and only a layout engine answers that. This mounts the Room's
 * bottom edge in headless Chrome — an inverted (`column-reverse`) transcript
 * viewport above the chrome stack, exactly the column `_chat-surface` renders
 * — drives the band through mount and unmount, and reads the newest row's
 * `getBoundingClientRect().top` at each step.
 *
 * Every number the page lays out is read out of the app: the band's fill and
 * hairline and the reserved slot rule come from `buzz/room-bottom-chrome`, and
 * the line's row, margin and label tokens from that module or, on a tree that
 * does not export them yet, from `TurnProgressLine`'s own stylesheet. So
 * dropping the rule or changing the reserve moves this proof, and it runs
 * unchanged on the tree before the fix — which is the run that reproduces the
 * jump.
 *
 * It runs the whole transition twice: once at the default text scale, once at
 * an accessibility scale large enough that the band is taller than the
 * default-scale fallback. The second run is the one that fails if the reserve
 * is measured off the visible band, because by then the taller band has
 * already taken its height out of the list.
 *
 * Run: node apps/mobile/scripts/turn-band-hold-proof.mjs
 * Exits non-zero when the newest row moves in either direction.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const MOBILE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.CHROME_BIN ?? 'google-chrome';

/** The phone viewport the band is judged in. */
const SCREEN = { width: 390, height: 780 };
/** Stand-in for the newest message row; its height is irrelevant to the shift. */
const NEWEST_ROW_HEIGHT = 44;
/**
 * Text scales the transition is driven at. 1 is the default; 1.8 is an
 * ordinary accessibility setting, and it makes the band taller than a reserve
 * computed from the default-scale tokens — the case a reserve measured off the
 * visible band cannot hold still.
 */
const TEXT_SCALES = [1, 1.8];

const out = mkdtempSync(join('/tmp', 'turn-band-proof-'));

// Bundle the app's own geometry module for the browser. Nothing about the
// band's box is retyped here.
const entry = join(out, 'entry.js');
writeFileSync(
  entry,
  `import * as chrome from ${JSON.stringify(join(MOBILE_DIR, 'sources/buzz/room-bottom-chrome.ts'))};
   import { phoneTranscriptTailPadding } from ${JSON.stringify(join(MOBILE_DIR, 'sources/buzz/room-scroll-follow.ts'))};
   globalThis.BEELINE_CHROME = chrome;
   globalThis.BEELINE_TAIL_PADDING = phoneTranscriptTailPadding;`,
);
await build({
  entryPoints: [entry],
  bundle: true,
  format: 'iife',
  outfile: join(out, 'geometry.js'),
  platform: 'browser',
  // `room-scroll-follow` carries React hooks beside its pure rules; the proof
  // only calls the pure padding function, so React never runs.
  external: ['react'],
  banner: { js: 'var require = () => ({ useLayoutEffect: () => {}, useRef: () => ({}) });' },
});

const geometry = readFileSync(join(out, 'geometry.js'), 'utf8');

// The band's own box tokens. This branch exports them from
// `room-bottom-chrome` so the line and the reserve cannot drift apart, but the
// proof has to lay out the band on a tree that predates those exports too —
// that is the run that reproduces the jump. So fall back to reading the
// numbers out of the line's own stylesheet rather than writing them here.
const lineSource = readFileSync(
  join(MOBILE_DIR, 'sources/components/buzz/TurnProgressLine.tsx'),
  'utf8',
);
const chromeSource = readFileSync(join(MOBILE_DIR, 'sources/buzz/room-bottom-chrome.ts'), 'utf8');
function bandToken(exportName, styleKey, property) {
  const exported = chromeSource.match(new RegExp(`${exportName} = (\\d+)`));
  if (exported) return Number(exported[1]);
  const block = lineSource.match(new RegExp(`\\n {4}${styleKey}: \\{[\\s\\S]*?\\n {4}\\}`));
  const inline = block?.[0].match(new RegExp(`${property}: (\\d+)`));
  if (!inline) throw new Error(`No ${exportName} export and no ${styleKey}.${property} literal`);
  return Number(inline[1]);
}
const bandTokens = {
  rowMinHeight: bandToken('TURN_LINE_ROW_MIN_HEIGHT', 'row', 'minHeight'),
  barMarginBottom: bandToken('TURN_LINE_BAR_MARGIN_BOTTOM', 'bar', 'marginBottom'),
  // The label's own type, which is what the reader's text scale multiplies.
  // No export claims these, so they come off the line's stylesheet.
  labelFontSize: bandToken('TURN_LINE_LABEL_FONT_SIZE', 'label', 'fontSize'),
  labelLineHeight: bandToken('TURN_LINE_LABEL_LINE_HEIGHT', 'label', 'lineHeight'),
};

const page = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html, body { margin: 0; padding: 0; }
  #screen { width: ${SCREEN.width}px; height: ${SCREEN.height}px; display: flex; flex-direction: column; overflow: hidden; }
  /* messageList: flex 1. Inverted native list == column-reverse: the newest
     row sits at the viewport's bottom edge, above the tail padding. */
  #transcript { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column-reverse; overflow: hidden; }
  #newest { flex: 0 0 auto; height: ${NEWEST_ROW_HEIGHT}px; }
  #older { flex: 0 0 auto; height: 2000px; }
</style></head><body>
<div id="screen">
  <div id="transcript"><div id="newest"></div><div id="older"></div></div>
  <div id="chrome"></div>
</div>
<pre id="result"></pre>
<script>${geometry}</script>
<script>
const chrome = globalThis.BEELINE_CHROME;
const bandTokens = ${JSON.stringify(bandTokens)};
const scales = ${JSON.stringify(TEXT_SCALES)};
const hull = { bgTerminal: '#140d1c', border: '#2e2438' };
const layout = chrome.roomBottomChromeStyles(hull);
const px = (n) => (n == null ? 0 : n) + 'px';
const round = (n) => Math.round(n * 100) / 100;

// The inverted list's own tail, straight from the app's rule.
const tail = globalThis.BEELINE_TAIL_PADDING({ turnChromeVisible: true, pushedChromeVisible: false });
document.getElementById('transcript').style.paddingBottom = px(tail);

// How this tree holds the slot open, read off the app rather than assumed:
//   unreserved — no reserve rule at all; the slot mounts with the band.
//   fallback   — the slot is permanent but its height is a floor the band can
//                push open, and the reserve is measured off the visible band.
//   measured   — the slot's height is exact and comes from a hidden copy of
//                the band that is laid out before any band is shown.
const reserves = typeof chrome.reservedTurnBandHeight === 'function';
const measureStyle = layout.turnBandMeasure ?? null;
const mode = !reserves ? 'unreserved' : measureStyle ? 'measured' : 'fallback';

const chromeStack = document.getElementById('chrome');
const composer = document.createElement('div');
Object.assign(composer.style, {
  paddingTop: px(layout.composerRow.paddingTop),
  borderTopStyle: 'solid',
  borderTopWidth: px(layout.composerRow.borderTopWidth),
  borderTopColor: layout.composerRow.borderTopColor,
  height: '52px',
});

/** The turn line's own box, at the reader's text scale, from the line's own
 *  tokens. The row is as tall as its tallest child, so a scaled-up label is
 *  what pushes the band past a reserve computed at the default scale. */
function buildBand(scale) {
  const bar = document.createElement('div');
  Object.assign(bar.style, {
    width: '100%',
    marginBottom: px(bandTokens.barMarginBottom),
    paddingLeft: '8px',
    paddingRight: '8px',
  });
  const row = document.createElement('div');
  Object.assign(row.style, {
    minHeight: px(bandTokens.rowMinHeight),
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'center',
    fontSize: px(bandTokens.labelFontSize * scale),
    lineHeight: px(bandTokens.labelLineHeight * scale),
  });
  row.textContent = 'nerd thinking…';
  bar.append(row);
  return bar;
}

function buildSlot() {
  const slot = document.createElement('div');
  Object.assign(slot.style, {
    backgroundColor: layout.hangingTurnChrome.backgroundColor,
    borderTopStyle: 'solid',
    borderTopWidth: px(layout.hangingTurnChrome.borderTopWidth),
    borderTopColor: layout.hangingTurnChrome.borderTopColor ?? 'transparent',
  });
  return slot;
}

const topOfNewest = () =>
  round(document.getElementById('newest').getBoundingClientRect().top);

/** Drive one whole transition — no band, band, no band — at one text scale. */
function run(scale) {
  chromeStack.textContent = '';
  const slot = buildSlot();
  let reserve = 0;

  if (mode !== 'unreserved') {
    // A reserved slot is mounted whether or not an agent is working.
    reserve = chrome.reservedTurnBandHeight({ reserved: null, measured: null });
    slot.style[mode === 'measured' ? 'height' : 'minHeight'] = px(reserve);
    chromeStack.append(slot);
  }
  chromeStack.append(composer);

  if (mode === 'measured') {
    // The hidden copy: mounted before any band, out of flow, laid out at this
    // text scale. Its height is what the slot then holds.
    const ruler = document.createElement('div');
    Object.assign(ruler.style, {
      position: measureStyle.position,
      left: px(measureStyle.left),
      right: px(measureStyle.right),
      top: px(measureStyle.top),
      opacity: String(measureStyle.opacity),
    });
    ruler.append(buildBand(scale));
    slot.append(ruler);
    reserve = chrome.reservedTurnBandHeight({
      reserved: null,
      measured: ruler.getBoundingClientRect().height,
    });
    slot.style.height = px(reserve);
  }

  const before = topOfNewest();
  const band = buildBand(scale);
  slot.append(band);
  // With no reserve rule the screen mounts the whole slot — fill, rule and all
  // — with the band, which is the tree this proof reproduces the jump on.
  if (mode === 'unreserved') chromeStack.prepend(slot);
  const during = topOfNewest();
  const bandBox = round(band.getBoundingClientRect().height + bandTokens.barMarginBottom);
  band.remove();
  if (mode === 'unreserved') slot.remove();
  const after = topOfNewest();

  return {
    scale, reserve: round(reserve), bandBox, before, during, after,
    onAppear: round(during - before),
    onGo: round(after - during),
  };
}

document.getElementById('result').textContent = JSON.stringify({
  mode, tail,
  rule: (layout.hangingTurnChrome.borderTopWidth ?? 0),
  runs: scales.map(run),
});
</script></body></html>`;

const pagePath = join(out, 'proof.html');
writeFileSync(pagePath, page);

const dom = execFileSync(
  CHROME,
  [
    '--headless',
    '--disable-gpu',
    '--no-sandbox',
    // Chrome's singleton socket lives under the profile and has a short path
    // limit; a deep default profile aborts the run before it draws anything.
    `--user-data-dir=${mkdtempSync(join('/tmp', 'blc-'))}`,
    '--virtual-time-budget=4000',
    `--window-size=${SCREEN.width},${SCREEN.height}`,
    '--dump-dom',
    `file://${pagePath}`,
  ],
  // Chrome puts its singleton socket under TMPDIR and that path has a short
  // limit, so a deep TMPDIR aborts the run before the page is laid out.
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TMPDIR: '/tmp' } },
);

const found = dom.match(/<pre id="result">([\s\S]*?)<\/pre>/);
if (!found) {
  console.error('The proof page did not report a measurement.');
  process.exit(2);
}
const m = JSON.parse(found[1]);

console.log(`Room bottom edge measured in headless Chrome at ${SCREEN.width}x${SCREEN.height}`);
console.log(`  transcript tail padding : ${m.tail}px`);
console.log(`  rule above the band     : ${m.rule}px`);
console.log(`  slot                    : ${m.mode}`);

for (const run of m.runs) {
  console.log('');
  console.log(`  text scale ${run.scale}x`);
  console.log(`    thinking band box : ${run.bandBox}px`);
  console.log(`    reserved slot     : ${run.reserve}px`);
  console.log('    newest message top, in screen px:');
  console.log(`      before the band : ${run.before}`);
  console.log(`      band showing    : ${run.during}`);
  console.log(`      after it goes   : ${run.after}`);
  console.log(`    moved on appear : ${run.onAppear}px`);
  console.log(`    moved on go     : ${run.onGo}px`);
}

const moved = m.runs.filter((run) => run.onAppear !== 0 || run.onGo !== 0);
const held = moved.length === 0;
const unfenced = m.rule === 0;
console.log('');
console.log(
  held
    ? 'HELD — the newest message never moves, at any text scale.'
    : `MOVED — the transcript jumps at text scale ${moved.map((run) => run.scale).join(', ')}.`,
);
console.log(
  unfenced
    ? 'UNFENCED — no rule above the band.'
    : `FENCED — a ${m.rule}px rule sits above the band.`,
);
process.exit(held && unfenced ? 0 : 1);
