import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Chrome marks are DRAWN, never typed.
 *
 * Space Grotesk carries none of `‹ › ⌃ ⌄ ◇ •`, so a mark set as a text
 * character paints from whatever fallback face the device happens to have,
 * at whatever height that face puts its ink. That is what the per-surface
 * `*_OPTICAL_Y` nudge constants were paying for, and it is why the same mark
 * read at a different weight on every screen.
 *
 * This scan is the thing that stops the next one slipping in. Four sites were
 * missed by eye on the first pass — one of them behind `'⌄'`, which no
 * grep for the character itself would ever find — so the scan normalises
 * escapes before it looks.
 */
const SOURCES = path.join(__dirname, '..');

/** Chrome marks that must be drawn, with the glyph that draws each one. */
const DRAWN: ReadonlyArray<{ chars: readonly string[]; glyph: string }> = [
  { chars: ['‹', '›', '⌃', '⌄'], glyph: 'ChevronGlyph' },
  { chars: ['◇', '└'], glyph: 'CornerGlyph' },
];

/**
 * Where a character is prose rather than chrome. `◇` is the corner
 * lifecycle sigil and is allowed to prefix a caption the way `#` prefixes a
 * Room name; `›` is allowed inside a written label (`New ›`). Both are words
 * on the page, not controls, so neither carries the defect this scan is for.
 */
const PROSE = new Set([
  'components/buzz/FaceCeremonyStep.tsx',
  'components/buzz/MonoHull.tsx',
  'components/DesktopRoomInspector.tsx',
  'app/(app)/beeline/onboarding.tsx',
  'app/(app)/beeline/chat/RoomMessageVariants.tsx',
]);

/** The glyph components themselves name the characters they replace. */
const GLYPHS = new Set([
  'components/buzz/ChevronGlyph.tsx',
  'components/buzz/CornerGlyph.tsx',
  'components/buzz/OverflowGlyph.tsx',
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith('.tsx') && !entry.includes('.test.')) out.push(full);
  }
  return out;
}

/** `'⌄'` and `'⌄'` are the same mark; read the source as the device does. */
function decodeEscapes(source: string): string {
  return source.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) =>
    String.fromCodePoint(Number.parseInt(hex, 16)),
  );
}

/** Comments explain the marks they replaced; they paint nothing. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

describe('chrome marks are drawn, never typed', () => {
  it('leaves no chevron or corner sigil set as a text character on any surface', () => {
    const offenders: string[] = [];
    for (const file of walk(SOURCES)) {
      const relative = path.relative(SOURCES, file).split(path.sep).join('/');
      if (GLYPHS.has(relative) || PROSE.has(relative)) continue;
      const source = stripComments(decodeEscapes(readFileSync(file, 'utf8')));
      for (const { chars, glyph } of DRAWN) {
        for (const char of chars) {
          if (source.includes(char)) {
            offenders.push(`${relative} types ${JSON.stringify(char)} — draw it with ${glyph}`);
          }
        }
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('keeps every surface free of a hand-tuned vertical correction for a mark', () => {
    // A shape centred on its own fixed box is level with the mark beside it
    // by construction. A nudge constant is the tell that something is still
    // being typed, or that a drawn mark was given a box it is not centred in.
    const offenders: string[] = [];
    for (const file of walk(SOURCES)) {
      const source = readFileSync(file, 'utf8');
      if (/OPTICAL_Y/.test(source)) {
        offenders.push(path.relative(SOURCES, file).split(path.sep).join('/'));
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});
