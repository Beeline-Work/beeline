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
    // icon-light.svg is the light splash source and icon-monochrome.svg is the
    // Android themed-icon source; neither carries brass or aubergine colors.
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
    expect(appConfig.ios.icon).toBe('./sources/assets/images/icon-ios.png');
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

  it('uses ink on cream for the light splash source and white on transparent for Android monochrome', () => {
    const lightSvg = readFileSync(
      new URL('../assets/images/icon-light.svg', import.meta.url),
      'utf8',
    );
    const monoChromeSvg = readFileSync(
      new URL('../assets/images/icon-monochrome.svg', import.meta.url),
      'utf8',
    );

    // Light splash source: cream field (#F3EEE4), ink loop (#171310)
    expect(lightSvg).toContain('rect width="1024" height="1024" fill="#F3EEE4"');
    expect(lightSvg).toContain('fill="#171310"');
    expect(lightSvg).toContain(adaptiveFraming);
    expect(lightSvg).not.toContain(canonicalInset);

    // Android monochrome icon: white loop on transparent, no background rect
    expect(monoChromeSvg).not.toMatch(/<rect/);
    expect(monoChromeSvg).toContain('fill="#FFFFFF"');
    expect(monoChromeSvg).toContain(adaptiveFraming);
    expect(monoChromeSvg).toContain(canonicalInset);
  });

  it('generates 1024x1024 PNGs for the light splash and Android monochrome icon', () => {
    const lightPng = readFileSync(
      new URL('../assets/images/icon-light.png', import.meta.url),
    );
    const monoChromePng = readFileSync(
      new URL('../assets/images/icon-adaptive-monochrome.png', import.meta.url),
    );

    // Check PNG dimensions via the file header (IHDR chunk at bytes 16-20)
    for (const png of [lightPng, monoChromePng]) {
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
      ['splash-android-light.png', '#F3EEE4'],
      ['splash-android-dark.png', '#14091A'],
    ] as const) {
      const [width, height] = await bounds(name, background);
      expect(width, `${name} width`).toBeGreaterThanOrEqual(480);
      expect(height, `${name} height`).toBeGreaterThanOrEqual(600);
    }

    // A browser renders this source at only 16–24 px. Its loop therefore has
    // a dedicated optical scale instead of inheriting the app-icon framing.
    const [faviconWidth, faviconHeight] = await bounds('favicon.png', '#14091A');
    expect(faviconWidth).toBeGreaterThanOrEqual(720);
    expect(faviconWidth).toBeLessThan(740);
    expect(faviconHeight).toBeGreaterThanOrEqual(900);
    expect(faviconHeight).toBeLessThan(950);

    // Status-bar small icon: 24×24 dp asset, 22×22 dp optical square. The
    // loop is taller than wide, so height fills that square and width stays
    // inside it. The 24 px mdpi raster must still read and must not clip.
    const notificationSource = readFileSync(new URL('icon-notification.png', images));
    const notificationMeta = await sharp(notificationSource).metadata();
    expect(notificationMeta.width).toBe(512);
    expect(notificationMeta.height).toBe(512);
    const opticalPx = Math.round((22 / 24) * 512);
    const { data: notificationPixels, info: notificationInfo } = await sharp(notificationSource)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    let minX = notificationInfo.width;
    let minY = notificationInfo.height;
    let maxX = -1;
    let maxY = -1;
    let edgeHits = 0;
    let tintedHits = 0;
    for (let y = 0; y < notificationInfo.height; y += 1) {
      for (let x = 0; x < notificationInfo.width; x += 1) {
        const at = (y * notificationInfo.width + x) * notificationInfo.channels;
        const [r, g, b, a] = [
          notificationPixels[at]!,
          notificationPixels[at + 1]!,
          notificationPixels[at + 2]!,
          notificationPixels[at + 3]!,
        ];
        if (a <= 8) continue;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
        if (r <= 240 || g <= 240 || b <= 240) tintedHits += 1;
        if (x === 0 || y === 0 || x === notificationInfo.width - 1 || y === notificationInfo.height - 1) {
          edgeHits += 1;
        }
      }
    }
    const notificationWidth = maxX - minX + 1;
    const notificationHeight = maxY - minY + 1;
    expect(notificationHeight, 'notification height').toBeGreaterThanOrEqual(opticalPx - 8);
    expect(notificationHeight, 'notification height').toBeLessThanOrEqual(opticalPx + 4);
    expect(notificationWidth, 'notification width').toBeGreaterThan(300);
    expect(notificationWidth, 'notification width').toBeLessThan(opticalPx);
    expect(tintedHits).toBe(0);
    expect(edgeHits).toBe(0);

    const { data: mdpiPixels, info: mdpiInfo } = await sharp(notificationSource)
      .resize(24, 24)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    let mdpiMinX = mdpiInfo.width;
    let mdpiMinY = mdpiInfo.height;
    let mdpiMaxX = -1;
    let mdpiMaxY = -1;
    let mdpiEdgeHits = 0;
    for (let y = 0; y < mdpiInfo.height; y += 1) {
      for (let x = 0; x < mdpiInfo.width; x += 1) {
        const at = (y * mdpiInfo.width + x) * mdpiInfo.channels;
        if (mdpiPixels[at + 3]! <= 8) continue;
        mdpiMinX = Math.min(mdpiMinX, x);
        mdpiMinY = Math.min(mdpiMinY, y);
        mdpiMaxX = Math.max(mdpiMaxX, x);
        mdpiMaxY = Math.max(mdpiMaxY, y);
        if (x === 0 || y === 0 || x === mdpiInfo.width - 1 || y === mdpiInfo.height - 1) {
          mdpiEdgeHits += 1;
        }
      }
    }
    expect(mdpiMaxY - mdpiMinY + 1).toBeGreaterThanOrEqual(20);
    expect(mdpiMaxY - mdpiMinY + 1).toBeLessThanOrEqual(23);
    expect(mdpiMaxX - mdpiMinX + 1).toBeGreaterThanOrEqual(14);
    expect(mdpiEdgeHits).toBe(0);

    for (const name of ['icon-adaptive.png', 'icon-adaptive-monochrome.png']) {
      const [width, height] = await bounds(name, null);
      expect(width, `${name} width`).toBeGreaterThanOrEqual(400);
      expect(width, `${name} width`).toBeLessThan(420);
      expect(height, `${name} height`).toBeGreaterThanOrEqual(500);
      expect(height, `${name} height`).toBeLessThan(530);
    }
  });

  it('keeps the desktop launcher full bleed with the natural unmasked loop proportion', async () => {
    const desktopIcon = sharp(
      readFileSync(new URL('../../src-tauri/icons/icon.png', import.meta.url)),
    );
    const { data, info } = await desktopIcon.raw().toBuffer({ resolveWithObject: true });
    const brassPoints: Array<[number, number]> = [];
    for (let y = 0; y < info.height; y += 1) {
      for (let x = 0; x < info.width; x += 1) {
        const at = (y * info.width + x) * info.channels;
        const [r, g, b] = [data[at]!, data[at + 1]!, data[at + 2]!];
        if (r > 150 && g > 90 && b < 120) brassPoints.push([x, y]);
      }
    }
    const xs = brassPoints.map(([x]) => x);
    const ys = brassPoints.map(([, y]) => y);
    const markWidth = Math.max(...xs) - Math.min(...xs) + 1;
    const markHeight = Math.max(...ys) - Math.min(...ys) + 1;
    expect(markWidth).toBeGreaterThanOrEqual(480);
    expect(markWidth).toBeLessThan(500);
    expect(markHeight).toBeGreaterThanOrEqual(590);
    expect(markHeight).toBeLessThan(620);

    const { info: opaqueBounds } = await desktopIcon
      .trim({ background: '#00000000', threshold: 1 })
      .toBuffer({ resolveWithObject: true });
    expect(opaqueBounds.width).toBe(1024);
    expect(opaqueBounds.height).toBe(1024);
  });
});
