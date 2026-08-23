import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import beelineMark from '../buzz/beeline-mark.json';
import brand from '../buzz/brand.json';

const LOCKED_LOOP_SHA256 = '819b2abe3c00a1704c0857e88be2468f840a7a8d353f0e482bab03671c1d19f7';
const vectorNames = [
  'icon.svg',
  'icon-adaptive.svg',
  'mark.svg',
  'mark-dark.svg',
  'favicon-active.svg',
  'logotype-dark.svg',
  'logotype-light.svg',
] as const;
const canonicalInset = 'transform="translate(20.087671 20.087671) scale(0.83260274)"';
const adaptiveFraming =
  'transform="translate(512 512) scale(4.266666667) translate(-120 -120)"';

describe('Beeline continuous-line logo assets', () => {
  const vectors = vectorNames.map((name) =>
    readFileSync(new URL(`../assets/images/${name}`, import.meta.url), 'utf8'),
  );
  const appConfig = readFileSync(new URL('../../app.config.js', import.meta.url), 'utf8');
  const generator = readFileSync(
    new URL('../../scripts/generate-monochrome-assets.sh', import.meta.url),
    'utf8',
  );
  const adaptiveBackground = readFileSync(
    new URL('../assets/images/icon-adaptive-background.svg', import.meta.url),
    'utf8',
  );

  it('locks every vector and the in-app mark to the original loop geometry', () => {
    expect(beelineMark.viewBox).toBe('0 0 240 240');
    expect(beelineMark.transform).toBe('translate(20.087671 20.087671) scale(0.83260274)');
    expect(beelineMark.fillRule).toBe('nonzero');
    expect(createHash('sha256').update(beelineMark.path).digest('hex')).toBe(
      LOCKED_LOOP_SHA256,
    );
    for (const vector of vectors) {
      expect(vector).toContain(beelineMark.path);
    }
  });

  it('keeps brass on aubergine across launcher, web, and splash surfaces', () => {
    expect(brand.mark).toBe('#E5A645');
    expect(vectors[0]).toContain('rect width="240" height="240" fill="#14091A"');
    expect(vectors[0]).toContain('fill="#E5A645"');
    expect(vectors[1]).toContain('fill="#E5A645"');
    expect(vectors[2]).toContain('fill="#E5A645"');
    expect(vectors[3]).toContain('fill="#14091A"');
    expect(vectors[4]).toContain('rect width="240" height="240" fill="#14091A"');
    expect(vectors[4]).toContain('fill="#E5A645"');
    expect(vectors[5]).toContain('fill="#14091A"');
    expect(vectors[6]).toContain('fill="#E5A645"');
    expect(adaptiveBackground).toContain('fill="#14091A"');
    expect([...vectors, adaptiveBackground, generator].join('\n')).not.toMatch(
      /#f0b95a|#C48A33|linearGradient/i,
    );

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
    expect(appConfig).toContain('backgroundColor: "#14091A"');
    // The opaque aubergine assets and both splash variants must never expose the old field.
    expect(appConfig).not.toContain('#090909');
  });

  it('limits the owner-approved 26%-larger margin to home-screen marks', () => {
    expect(vectors[0]).toContain(canonicalInset);
    expect(vectors[1]).toContain(canonicalInset);
    expect(vectors[1]).toContain(adaptiveFraming);
    for (const vector of vectors.slice(2)) {
      expect(vector).not.toContain(canonicalInset);
      expect(vector).not.toContain(adaptiveFraming);
    }

    expect(generator).toMatch(/rsvg-convert[^\n]*icon-adaptive\.svg[\s\S]*?icon-adaptive\.png/);
    expect(generator).toMatch(/recolor_svg[^\n]*icon-adaptive\.svg[\s\S]*?icon-monochrome\.png/);
    // Surface assets are rendered from mark.svg / the ink field, never from the launcher source.
    expect(generator).not.toMatch(/icon-adaptive\.svg"[^\n]*(?:favicon|splash|notification)/);
  });
});
