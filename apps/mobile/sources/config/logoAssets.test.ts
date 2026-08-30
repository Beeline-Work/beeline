import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import beelineMark from '../buzz/beeline-mark.json';
import brand from '../buzz/brand.json';

const appConfig = (await import('../../app.config.js')).default.expo;

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
    expect([...vectors, adaptiveBackground].join('\n')).not.toMatch(
      /#f0b95a|#C48A33|linearGradient/i,
    );

    expect(appConfig.icon).toBe('./sources/assets/images/icon.png');
    expect(appConfig.android.adaptiveIcon).toEqual({
      foregroundImage: './sources/assets/images/icon-adaptive.png',
      backgroundImage: './sources/assets/images/icon-adaptive-background.png',
      backgroundColor: '#14091A',
    });
    expect(appConfig.web.favicon).toBe('./sources/assets/images/favicon.png');
    const notificationPlugin = appConfig.plugins.find(
      (plugin: unknown) => Array.isArray(plugin) && plugin[0] === 'expo-notifications',
    );
    expect(notificationPlugin?.[1]).toMatchObject({
      icon: './sources/assets/images/icon-notification.png',
    });
    const splashPlugin = appConfig.plugins.find(
      (plugin: unknown) => Array.isArray(plugin) && plugin[0] === 'expo-splash-screen',
    );
    expect(splashPlugin?.[1]).toMatchObject({
      android: {
        image: './sources/assets/images/splash-android-light.png',
        imageWidth: 150,
        resizeMode: 'contain',
        backgroundColor: '#14091A',
        dark: {
          image: './sources/assets/images/splash-android-dark.png',
          backgroundColor: '#14091A',
        },
      },
    });
    expect(JSON.stringify(appConfig)).not.toContain('#090909');
  });

  it('limits the owner-approved 26%-larger margin to home-screen marks', () => {
    expect(vectors[0]).toContain(canonicalInset);
    expect(vectors[1]).toContain(canonicalInset);
    expect(vectors[1]).toContain(adaptiveFraming);
    for (const vector of vectors.slice(2)) {
      expect(vector).not.toContain(canonicalInset);
      expect(vector).not.toContain(adaptiveFraming);
    }

    expect(appConfig.android.adaptiveIcon.foregroundImage).toBe(
      './sources/assets/images/icon-adaptive.png',
    );
  });
});
