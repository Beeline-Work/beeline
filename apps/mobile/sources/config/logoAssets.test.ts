import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import sharp from 'sharp';

import { describe, expect, it } from 'vitest';

import beelineMark from '../buzz/beeline-mark.json';
import brand from '../buzz/brand.json';

const appConfig = (await import('../../app.config.js')).default.expo;

const LOCKED_LOOP_SHA256 = '819b2abe3c00a1704c0857e88be2468f840a7a8d353f0e482bab03671c1d19f7';
const LIGHT_SPLASH_SHA256 = '5941f621854629123fc877f4bd9825cc9ae7249b9c527937244e7da93df7e697';
const DARK_SPLASH_SHA256 = '5e396029b6af5a586d4259550b75a98c12071f78d3c2334ab9d92ef7e8f12b79';
const vectorNames = [
  'icon.svg',
  'icon-adaptive.svg',
  'icon-light.svg',
  'icon-monochrome.svg',
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

  it('keeps brass on aubergine across icon and web surfaces', () => {
    expect(brand.mark).toBe('#E5A645');
    expect(vectors[0]).toContain('rect width="240" height="240" fill="#14091A"');
    expect(vectors[0]).toContain('fill="#E5A645"');
    expect(vectors[1]).toContain('fill="#E5A645"');
    // icon-light.svg and icon-monochrome.svg are the new light/monochrome icon
    // variants; they do not carry brass or aubergine colors.
    expect(vectors[4]).toContain('fill="#E5A645"');
    expect(vectors[5]).toContain('fill="#14091A"');
    expect(vectors[6]).toContain('rect width="240" height="240" fill="#14091A"');
    expect(vectors[6]).toContain('fill="#E5A645"');
    expect(vectors[7]).toContain('fill="#14091A"');
    expect(vectors[8]).toContain('fill="#E5A645"');
    expect(adaptiveBackground).toContain('fill="#14091A"');
    expect([...vectors, adaptiveBackground].join('\n')).not.toMatch(
      /#f0b95a|#C48A33|linearGradient/i,
    );

    expect(appConfig.icon).toBe('./sources/assets/images/icon.png');
    expect(appConfig.ios.icon).toMatchObject({
      light: './sources/assets/images/icon-light.png',
      dark: './sources/assets/images/icon-ios.png',
      tinted: './sources/assets/images/icon-ios-tinted.png',
    });
    expect(appConfig.android.adaptiveIcon).toEqual({
      foregroundImage: './sources/assets/images/icon-adaptive.png',
      backgroundImage: './sources/assets/images/icon-adaptive-background.png',
      backgroundColor: '#14091A',
      monochromeImage: './sources/assets/images/icon-adaptive-monochrome.png',
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
      ios: {
        image: './sources/assets/images/splash-android-light.png',
        imageWidth: 125,
        resizeMode: 'contain',
        backgroundColor: '#F3EEE4',
        dark: {
          image: './sources/assets/images/splash-android-dark.png',
          backgroundColor: '#14091A',
        },
      },
      android: {
        image: './sources/assets/images/splash-android-light.png',
        imageWidth: 125,
        resizeMode: 'contain',
        backgroundColor: '#F3EEE4',
        dark: {
          image: './sources/assets/images/splash-android-dark.png',
          backgroundColor: '#14091A',
        },
      },
    });
    expect(JSON.stringify(appConfig)).not.toContain('#090909');
  });

  it('uses ink on cream for the default iOS light icon and white on transparent for tinted/monochrome', () => {
    const lightSvg = readFileSync(
      new URL('../assets/images/icon-light.svg', import.meta.url),
      'utf8',
    );
    const monoChromeSvg = readFileSync(
      new URL('../assets/images/icon-monochrome.svg', import.meta.url),
      'utf8',
    );

    // Light icon: cream field (#F3EEE4), ink loop (#171310)
    expect(lightSvg).toContain('rect width="1024" height="1024" fill="#F3EEE4"');
    expect(lightSvg).toContain('fill="#171310"');
    expect(lightSvg).toContain(adaptiveFraming);
    expect(lightSvg).not.toContain(canonicalInset);

    // Monochrome icon: white loop on transparent, no background rect
    expect(monoChromeSvg).not.toMatch(/<rect/);
    expect(monoChromeSvg).toContain('fill="#FFFFFF"');
    expect(monoChromeSvg).toContain(adaptiveFraming);
    expect(monoChromeSvg).toContain(canonicalInset);
  });

  it('generates 1024x1024 PNGs for the new icon variants', () => {
    const lightPng = readFileSync(
      new URL('../assets/images/icon-light.png', import.meta.url),
    );
    const tintedPng = readFileSync(
      new URL('../assets/images/icon-ios-tinted.png', import.meta.url),
    );
    const monoChromePng = readFileSync(
      new URL('../assets/images/icon-adaptive-monochrome.png', import.meta.url),
    );

    // Check PNG dimensions via the file header (IHDR chunk at bytes 16-20)
    for (const png of [lightPng, tintedPng, monoChromePng]) {
      expect(png[0]).toBe(0x89); // PNG magic byte
      const width = png.readUInt32BE(16);
      const height = png.readUInt32BE(20);
      expect(width).toBe(1024);
      expect(height).toBe(1024);
    }
  });

  it('uses the canonical swirl in ink on ivory for the light splash', () => {
    const lightSplash = readFileSync(
      new URL('../assets/images/splash-android-light.png', import.meta.url),
    );
    const darkSplash = readFileSync(
      new URL('../assets/images/splash-android-dark.png', import.meta.url),
    );

    expect(createHash('sha256').update(lightSplash).digest('hex')).toBe(LIGHT_SPLASH_SHA256);
    expect(createHash('sha256').update(darkSplash).digest('hex')).toBe(DARK_SPLASH_SHA256);
  });

  it('limits the safe-zone inset to Android adaptive foregrounds', () => {
    expect(vectors[0]).not.toContain(canonicalInset);
    expect(vectors[1]).toContain(canonicalInset);
    expect(vectors[1]).toContain(adaptiveFraming);
    // iOS light is OS-masked from a full source; Android monochrome is an
    // adaptive foreground and keeps the same safe zone as the brass twin.
    expect(vectors[2]).not.toContain(canonicalInset);
    expect(vectors[2]).toContain(adaptiveFraming);
    expect(vectors[3]).toContain(canonicalInset);
    expect(vectors[3]).toContain(adaptiveFraming);
    for (const vector of vectors.slice(4)) {
      expect(vector).not.toContain(canonicalInset);
      expect(vector).not.toContain(adaptiveFraming);
    }

    expect(appConfig.android.adaptiveIcon.foregroundImage).toBe(
      './sources/assets/images/icon-adaptive.png',
    );
  });

  it('ships full-size marks on unmasked rasters and preserves adaptive bounds', async () => {
    const images = new URL('../assets/images/', import.meta.url);
    const bounds = async (name: string, background: string | null) => {
      const image = sharp(readFileSync(new URL(name, images)));
      const { info } = await image
        .trim(background ? { background, threshold: 8 } : { threshold: 1 })
        .toBuffer({ resolveWithObject: true });
      return [info.width, info.height] as const;
    };

    for (const [name, background] of [
      ['icon.png', '#14091A'],
      ['icon-ios.png', '#14091A'],
      ['icon-light.png', '#F3EEE4'],
      ['favicon.png', '#14091A'],
      ['splash-android-light.png', '#F3EEE4'],
      ['splash-android-dark.png', '#14091A'],
      ['icon-ios-tinted.png', null],
    ] as const) {
      const [width, height] = await bounds(name, background);
      expect(width, `${name} width`).toBeGreaterThanOrEqual(480);
      expect(height, `${name} height`).toBeGreaterThanOrEqual(600);
    }

    for (const name of ['icon-adaptive.png', 'icon-adaptive-monochrome.png']) {
      const [width, height] = await bounds(name, null);
      expect(width, `${name} width`).toBeGreaterThanOrEqual(400);
      expect(width, `${name} width`).toBeLessThan(420);
      expect(height, `${name} height`).toBeGreaterThanOrEqual(500);
      expect(height, `${name} height`).toBeLessThan(530);
    }
  });
});
