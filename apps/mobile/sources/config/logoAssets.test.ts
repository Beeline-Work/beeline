import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import beelineMark from '../buzz/beeline-mark.json';

const LOCKED_ALLOY_SHA256 = 'cb52f797010a0da6e233bff9aaaf9c0fb021c022e3c89e70c756a79e73430d9c';
const vectorNames = [
  'icon.svg',
  'icon-adaptive.svg',
  'mark.svg',
  'mark-dark.svg',
  'favicon-active.svg',
] as const;
const CANONICAL_ALLOY_PATH =
  'M 0 -100 A 100 100 0 0 0 0 100 L 100 100 L 100 -100 Z M 9 -58 L 67 42 L -49 42 Z';
// The canonical optical shift: the mark group sits at translate(-9,0) inside the
// -124..124 viewBox, and every re-hosted wrapper preserves it verbatim rather
// than canceling or reversing it.
const launcherFraming = 'transform="translate(512 512) scale(2.4576)"';

describe('Beeline Alloy logo assets', () => {
  const vectors = vectorNames.map((name) =>
    readFileSync(new URL(`../assets/images/${name}`, import.meta.url), 'utf8'),
  );
  const appConfig = readFileSync(new URL('../../app.config.js', import.meta.url), 'utf8');

  it('locks every vector and the in-app mark to the canonical Alloy coin geometry', () => {
    expect(beelineMark.path).toBe(CANONICAL_ALLOY_PATH);
    expect(beelineMark.transform).toBe('translate(-9,0)');
    expect(beelineMark.viewBox).toBe('-124 -124 248 248');
    expect(createHash('sha256').update(beelineMark.path).digest('hex')).toBe(
      LOCKED_ALLOY_SHA256,
    );
    for (const vector of vectors) {
      expect(vector).toContain(CANONICAL_ALLOY_PATH);
      expect(vector).toContain('fill-rule="evenodd"');
    }
  });

  it('keeps the Speakeasy colorways and wires distinct launcher, web, splash, and notification assets', () => {
    // App icon + adaptive background: ink mark on the brass gradient tile.
    expect(vectors[0]).toContain('#14091A');
    expect(vectors[0]).toMatch(/#f0b95a[\s\S]*#E5A645[\s\S]*#C48A33/);
    expect(vectors[1]).toContain('#14091A');
    // Dark-surface / favicon / splash: brass mark on the ink field.
    expect(vectors.slice(2).join('\n')).toContain('#E5A645');
    expect(readFileSync(new URL('../assets/images/favicon-active.svg', import.meta.url), 'utf8'))
      .toContain('rect width="240" height="240" fill="#14091A"');

    expect(appConfig).toContain('icon: "./sources/assets/images/icon.png"');
    expect(appConfig).toContain('foregroundImage: "./sources/assets/images/icon-adaptive.png"');
    expect(appConfig).toContain(
      'monochromeImage: "./sources/assets/images/icon-monochrome.png"',
    );
    expect(appConfig)
      .toContain('backgroundImage: "./sources/assets/images/icon-adaptive-background.png"');
    expect(appConfig).toContain('favicon: "./sources/assets/images/favicon.png"');
    expect(appConfig).toContain('"icon": "./sources/assets/images/icon-notification.png"');
    expect(appConfig).toContain('image: "./sources/assets/images/splash-android-light.png"');
    expect(appConfig).toContain('image: "./sources/assets/images/splash-android-dark.png"');
    // The splash tiles are opaque ink; the screen backgroundColor must blend with them.
    expect(appConfig).not.toContain('#090909');
  });

  it('limits the owner-approved extra launcher margin to the adaptive foreground only', () => {
    expect(vectors[1]).toContain(launcherFraming);
    for (const vector of vectors.filter((_, i) => i !== 1)) {
      expect(vector).not.toContain(launcherFraming);
    }

    const generator = readFileSync(
      new URL('../../scripts/generate-monochrome-assets.sh', import.meta.url),
      'utf8',
    );
    expect(generator).toMatch(/rsvg-convert[^\n]*icon-adaptive\.svg[\s\S]*?icon-adaptive\.png/);
    expect(generator).toMatch(/recolor_svg[^\n]*icon-adaptive\.svg[\s\S]*?icon-monochrome\.png/);
    // Surface assets are rendered from mark.svg / the ink field, never from the launcher source.
    expect(generator).not.toMatch(/icon-adaptive\.svg"[^\n]*(?:favicon|splash|notification)/);
  });
});
