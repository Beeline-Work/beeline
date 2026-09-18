import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  GLYPH_PAINT,
  buildGlyphPaintProofHtml,
  glyphPaintCaptureSvg,
  glyphPaintProofFrames,
  ribbon,
} from './beeline-glyph';

describe('glyph paint capture', () => {
  it('paints brass on aubergine and ink on cream, never a row of dots', () => {
    const dark = glyphPaintCaptureSvg({
      dark: true,
      framing: 'icon',
      ground: true,
      progress: 0.45,
      size: 150,
    });
    const light = glyphPaintCaptureSvg({
      dark: false,
      framing: 'icon',
      ground: true,
      progress: 0.45,
      size: 150,
    });
    expect(dark).toContain(`fill="${GLYPH_PAINT.darkGround}"`);
    expect(dark).toContain(`stroke="${GLYPH_PAINT.darkInk}"`);
    expect(dark).toContain(ribbon.path);
    expect(light).toContain(`fill="${GLYPH_PAINT.lightGround}"`);
    expect(light).toContain(`stroke="${GLYPH_PAINT.lightInk}"`);
    expect(dark).not.toContain('r="2.5"');
    expect(light).not.toContain('circle');
  });

  it('holds a filled mark when the splash completes or motion is reduced', () => {
    const complete = glyphPaintCaptureSvg({
      dark: true,
      framing: 'icon',
      progress: 1,
      size: 150,
      still: true,
    });
    const still = glyphPaintCaptureSvg({
      dark: false,
      framing: 'cell',
      progress: 0.2,
      size: 18,
      still: true,
    });
    expect(complete).toContain(`fill="${GLYPH_PAINT.darkInk}"`);
    expect(complete).not.toContain('stroke-dasharray');
    expect(still).toContain(`fill="${GLYPH_PAINT.lightInk}"`);
    expect(still).not.toContain('stroke-dashoffset');
  });

  it('returns the thinking stroke to empty rest instead of holding a finish', () => {
    const rest = glyphPaintCaptureSvg({
      dark: true,
      framing: 'cell',
      progress: 0,
      size: 18,
    });
    expect(rest).toContain(`stroke-dashoffset="${ribbon.length}"`);
    expect(rest).not.toContain(`fill="${GLYPH_PAINT.darkInk}"`);
  });

  it('keeps the committed proof in lockstep with both themes', () => {
    const html = buildGlyphPaintProofHtml();
    const committed = readFileSync(
      new URL('../../design/glyph-paint-proof.html', import.meta.url),
      'utf8',
    );
    expect(committed).toBe(html);
    const ids = glyphPaintProofFrames().map((frame) => frame.id);
    expect(ids).toEqual([
      'splash-dark-mid',
      'splash-dark-complete',
      'splash-light-mid',
      'splash-light-complete',
      'thinking-dark-mid',
      'thinking-dark-rest',
      'thinking-dark-still',
      'thinking-light-mid',
      'thinking-light-rest',
      'thinking-light-still',
    ]);
    expect(html).toContain(GLYPH_PAINT.darkGround);
    expect(html).toContain(GLYPH_PAINT.lightGround);
    expect(html).toContain(GLYPH_PAINT.darkInk);
    expect(html).toContain(GLYPH_PAINT.lightInk);
    expect(html).not.toContain('PixelLoader');
    expect(html).not.toMatch(/width="5"/);
  });
});
