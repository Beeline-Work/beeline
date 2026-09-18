import beelineMark from './beeline-mark.json';
import brand from './brand.json';

/** The square the thinking mark sits in: as tall as the 12px mono label's 18px line. */
export const MARK_CELL = 18;
/** Fraction of the cell the mark's height takes — the optical size of the label's glyphs. */
const MARK_CELL_FILL = 13 / 18;
/** Stroke width in path units while the glyph is painting. */
export const GLYPH_STROKE = 7;
/** Matches expo-splash-screen `imageWidth` so the painted mark sits where the OS splash did. */
export const SPLASH_GLYPH_SIZE = 150;

/** Splash paints once. Completion is honest: loading ends. */
export const SPLASH_PAINT_MS = 900;
/** Thinking paints, then immediately releases. It never holds the completed stroke. */
export const RELEASE_PAINT_MS = 720;
export const RELEASE_UNWIND_MS = 880;
/** Brief rest at empty so the loop returns to nothing instead of restarting at the finish. */
export const RELEASE_REST_MS = 280;
export const RELEASE_CYCLE_MS = RELEASE_PAINT_MS + RELEASE_UNWIND_MS + RELEASE_REST_MS;

/**
 * Icon artwork colours, not the UI accent. Brass on aubergine is the dark icon;
 * ink on cream is the light icon, because brass on cream is weak.
 */
export const GLYPH_PAINT = {
  darkGround: '#14091A',
  lightGround: '#F3EEE4',
  darkInk: brand.mark,
  lightInk: '#171310',
} as const;

export function glyphPaintInk(dark: boolean): string {
  return dark ? GLYPH_PAINT.darkInk : GLYPH_PAINT.lightInk;
}

export function glyphPaintGround(dark: boolean): string {
  return dark ? GLYPH_PAINT.darkGround : GLYPH_PAINT.lightGround;
}

/**
 * The shipped mark is one closed polyline — the outline of a continuous ribbon.
 * `cell` crops to the mark so it fills the thinking line's 18px square.
 * `icon` keeps the 240-unit canvas and inset transform the launcher splash uses.
 */
export const ribbon = (() => {
  const points = Array.from(
    beelineMark.path.matchAll(/[ML]\s*([\d.]+)\s+([\d.]+)/g),
    ([, x, y]) => [Number(x), Number(y)] as const,
  );
  let length = 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  points.forEach(([x, y], index) => {
    const [nextX, nextY] = points[(index + 1) % points.length]!;
    length += Math.hypot(nextX - x, nextY - y);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  });
  const side = Math.max(maxX - minX, maxY - minY) / MARK_CELL_FILL;
  const originX = (minX + maxX - side) / 2;
  const originY = (minY + maxY - side) / 2;
  return {
    path: beelineMark.path,
    length,
    fillRule: beelineMark.fillRule,
    transform: beelineMark.transform,
    iconViewBox: beelineMark.viewBox,
    cellViewBox: `${originX.toFixed(3)} ${originY.toFixed(3)} ${side.toFixed(3)} ${side.toFixed(3)}`,
  };
})();

export type GlyphPaintFraming = 'icon' | 'cell';

export function glyphViewBox(framing: GlyphPaintFraming): string {
  return framing === 'icon' ? ribbon.iconViewBox : ribbon.cellViewBox;
}

function dashOffset(progress: number): number {
  return ribbon.length * (1 - progress);
}

/**
 * Theme-accurate SVG of the glyph at one progress value. Splash captures sit
 * on the locked ground; thinking captures are the mark alone so a proof page
 * can place them on the same canvas.
 */
export function glyphPaintCaptureSvg(opts: {
  dark: boolean;
  progress: number;
  size: number;
  framing: GlyphPaintFraming;
  still?: boolean;
  ground?: boolean;
}): string {
  const ink = glyphPaintInk(opts.dark);
  const complete = Boolean(opts.still) || opts.progress >= 1;
  const transform =
    opts.framing === 'icon' ? ` transform="${ribbon.transform}"` : '';
  const mark = complete
    ? `<path d="${ribbon.path}" fill="${ink}" fill-rule="${ribbon.fillRule}"/>`
    : `<path d="${ribbon.path}" fill="none" stroke="${ink}" stroke-width="${GLYPH_STROKE}" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="${ribbon.length} ${ribbon.length}" stroke-dashoffset="${dashOffset(opts.progress)}"/>`;
  const inner = transform ? `<g${transform}>${mark}</g>` : mark;
  const background = opts.ground
    ? `<rect width="100%" height="100%" fill="${glyphPaintGround(opts.dark)}"/>`
    : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${glyphViewBox(opts.framing)}" width="${opts.size}" height="${opts.size}">${background}${inner}</svg>`;
}

type ProofFrame = {
  id: string;
  title: string;
  dark: boolean;
  progress: number;
  size: number;
  framing: GlyphPaintFraming;
  still?: boolean;
};

const PROOF_FRAMES: readonly ProofFrame[] = [
  {
    id: 'splash-dark-mid',
    title: 'Splash · dark · painting',
    dark: true,
    progress: 0.45,
    size: SPLASH_GLYPH_SIZE,
    framing: 'icon',
  },
  {
    id: 'splash-dark-complete',
    title: 'Splash · dark · complete (handoff)',
    dark: true,
    progress: 1,
    size: SPLASH_GLYPH_SIZE,
    framing: 'icon',
    still: true,
  },
  {
    id: 'splash-light-mid',
    title: 'Splash · light · painting',
    dark: false,
    progress: 0.45,
    size: SPLASH_GLYPH_SIZE,
    framing: 'icon',
  },
  {
    id: 'splash-light-complete',
    title: 'Splash · light · complete (handoff)',
    dark: false,
    progress: 1,
    size: SPLASH_GLYPH_SIZE,
    framing: 'icon',
    still: true,
  },
  {
    id: 'thinking-dark-mid',
    title: 'Thinking · dark · painting',
    dark: true,
    progress: 0.55,
    size: MARK_CELL * 4,
    framing: 'cell',
  },
  {
    id: 'thinking-dark-rest',
    title: 'Thinking · dark · rest',
    dark: true,
    progress: 0,
    size: MARK_CELL * 4,
    framing: 'cell',
  },
  {
    id: 'thinking-dark-still',
    title: 'Thinking · dark · reduced motion',
    dark: true,
    progress: 1,
    size: MARK_CELL * 4,
    framing: 'cell',
    still: true,
  },
  {
    id: 'thinking-light-mid',
    title: 'Thinking · light · painting',
    dark: false,
    progress: 0.55,
    size: MARK_CELL * 4,
    framing: 'cell',
  },
  {
    id: 'thinking-light-rest',
    title: 'Thinking · light · rest',
    dark: false,
    progress: 0,
    size: MARK_CELL * 4,
    framing: 'cell',
  },
  {
    id: 'thinking-light-still',
    title: 'Thinking · light · reduced motion',
    dark: false,
    progress: 1,
    size: MARK_CELL * 4,
    framing: 'cell',
    still: true,
  },
];

export function glyphPaintProofFrames(): readonly ProofFrame[] {
  return PROOF_FRAMES;
}

export function buildGlyphPaintProofHtml(): string {
  const cards = PROOF_FRAMES.map((frame) => {
    const ground = glyphPaintGround(frame.dark);
    const svg = glyphPaintCaptureSvg({ ...frame, ground: true });
    return `<figure data-frame="${frame.id}" data-ground="${ground}" style="margin:0;padding:24px;background:${ground};color:${glyphPaintInk(frame.dark)}"><figcaption style="font:500 13px/18px 'IBM Plex Mono',ui-monospace,monospace;letter-spacing:0.4px;margin-bottom:16px">${frame.title}</figcaption>${svg}</figure>`;
  }).join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>Beeline glyph paint</title>
<style>
  html,body{margin:0;background:#14091A;color:#E5A645}
  body{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:1px;background:#291e33}
  figure svg{display:block;margin:0 auto}
</style>
</head>
<body>
${cards}
</body>
</html>
`;
}
