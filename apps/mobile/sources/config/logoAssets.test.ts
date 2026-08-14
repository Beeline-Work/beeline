import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import beelineMark from '../buzz/beeline-mark.json';

const LOCKED_MARK_SHA256 = '819b2abe3c00a1704c0857e88be2468f840a7a8d353f0e482bab03671c1d19f7';
const vectorNames = [
  'icon.svg',
  'mark.svg',
  'mark-dark.svg',
  'favicon-active.svg',
  'logotype-dark.svg',
  'logotype-light.svg',
] as const;
const launcherInset = 'transform="translate(20.087671 20.087671) scale(0.83260274)"';

describe('Beeline continuous-line logo assets', () => {
  const vectors = vectorNames.map((name) =>
    readFileSync(new URL(`../assets/images/${name}`, import.meta.url), 'utf8'),
  );
  const appConfig = readFileSync(new URL('../../app.config.js', import.meta.url), 'utf8');

  it('locks every vector and the in-app mark to the approved Gesture A outline', () => {
    expect(createHash('sha256').update(beelineMark.path).digest('hex')).toBe(LOCKED_MARK_SHA256);
    for (const vector of vectors) expect(vector).toContain(beelineMark.path);
  });

  it('keeps the logo pipeline monochrome and wired to distinct launcher, web, splash, and notification assets', () => {
    expect(vectors.join('\n')).not.toMatch(/gold|#d7af5f|#d8d8d8/i);
    expect(appConfig).toContain('icon: "./sources/assets/images/icon.png"');
    expect(appConfig).toContain('foregroundImage: "./sources/assets/images/icon-adaptive.png"');
    expect(appConfig).toContain('monochromeImage: "./sources/assets/images/icon-monochrome.png"');
    expect(appConfig).toContain('favicon: "./sources/assets/images/favicon.png"');
    expect(appConfig).toContain('"icon": "./sources/assets/images/icon-notification.png"');
    expect(appConfig).toContain('image: "./sources/assets/images/splash-android-light.png"');
    expect(appConfig).toContain('image: "./sources/assets/images/splash-android-dark.png"');
  });

  it('limits the approved 26%-larger margin to launcher assets', () => {
    expect(vectors[0]).toContain(launcherInset);
    for (const vector of vectors.slice(1)) expect(vector).not.toContain(launcherInset);

    const generator = readFileSync(
      new URL('../../scripts/generate-monochrome-assets.sh', import.meta.url),
      'utf8',
    );
    expect(generator).toMatch(/render_launcher_foreground[^\n]+icon-adaptive\.png/);
    expect(generator).toMatch(/render_launcher_foreground[^\n]+icon-monochrome\.png/);
    expect(generator).not.toMatch(/render_launcher_foreground[^\n]+(?:favicon|splash|notification)/);
  });
});
