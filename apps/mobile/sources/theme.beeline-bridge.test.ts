import { describe, expect, it, vi } from 'vitest';

// theme.ts reads react-native's Platform.select at import time.
vi.mock('react-native', () => ({
  Platform: { OS: 'android', select: (choices: Record<string, unknown>) => choices.default },
}));

import { beelineThemes } from './buzz/groknight';
import {
  boneTheme,
  obsidianLargeTheme,
  obsidianSmallTheme,
  obsidianTheme,
} from './theme';

const bridged = [obsidianTheme, boneTheme];

describe('the legacy-theme bridge carries the Speakeasy language to lesser screens', () => {
  it('maps the Beeline theme onto the app canvas and brass accent', () => {
    for (const theme of bridged) {
      // The canvas: every screen that reads legacy background tokens still
      // lands on the Speakeasy aubergine, never on the old graphite/black.
      expect(theme.colors.surface).toBe(theme.buzz.bgBase);
      expect(theme.colors.groupped.background).toBe(theme.buzz.bgTerminal);
      expect(theme.colors.header.background).toBe(theme.buzz.bgBase);
    }
    expect(obsidianTheme.buzz.name).toBe('obsidian');
    expect(boneTheme.buzz.name).toBe('bone');
  });

  it('carries dark/light through the bridge, not the legacy base object it was spread from', () => {
    // The bridge builds every theme by spreading the legacy darkTheme object
    // (whose own `dark` field is a fixed `true`) and layering buzz tokens on
    // top. `theme.dark` is what MobileGlass/StatusBarProvider/AnimatedOverlay
    // branch their blur tint and status bar style on, so it must track the
    // buzz set actually in use, not the legacy base's literal default.
    expect(obsidianTheme.dark).toBe(true);
    expect(boneTheme.dark).toBe(false);
  });

  it('never ships the iOS default green or blue through toggles or status', () => {
    const IOS_GREEN = '#34C759';
    const ANDROID_BLUE = '#1976D2';
    for (const theme of bridged) {
      // Settings switches: track spends brass, not the platform default.
      expect(theme.colors.switch.track.active).toBe(theme.buzz.accent);
      expect(theme.colors.switch.track.active).not.toBe(IOS_GREEN);
      expect(theme.colors.switch.track.active).not.toBe(ANDROID_BLUE);
      expect(theme.colors.switch.track.inactive).toBe(theme.buzz.bgTexturePeak);
      // Live/online presence is brass product-wide.
      expect(theme.colors.status.connected).toBe(theme.buzz.accent);
    }
  });

  it('keeps the prose ladder readable from the bridge', () => {
    for (const theme of bridged) {
      expect(theme.buzz.proseRegular).toBeTruthy();
      expect(theme.buzz.proseSemibold).toBeTruthy();
    }
    // The obsidian ladder is Space Grotesk — the transcript family — which is
    // what the lesser screens now read instead of hardwired Plex Sans.
    expect(beelineThemes.obsidian.proseRegular).toBe('SpaceGrotesk-Regular');
    expect(beelineThemes.obsidian.proseSemibold).toBe('SpaceGrotesk-SemiBold');
  });

  it('scales native type without scaling geometry', () => {
    expect(obsidianSmallTheme.buzz.type.body.fontSize).toBeCloseTo(13.76);
    expect(obsidianLargeTheme.buzz.type.body.fontSize).toBeCloseTo(19.2);
    expect(obsidianSmallTheme.buzz.proseSize).toBeCloseTo(13.76);
    expect(obsidianLargeTheme.buzz.proseSize).toBeCloseTo(19.2);
    expect(obsidianSmallTheme.buzz.type.sectionHead.letterSpacing).toBe(2);
    expect(obsidianLargeTheme.buzz.type.hero.letterSpacing).toBe(-0.3);
    expect(obsidianSmallTheme.buzz.layout).toEqual(obsidianTheme.buzz.layout);
    expect(obsidianLargeTheme.buzz.space).toEqual(obsidianTheme.buzz.space);
    expect(obsidianSmallTheme.buzz.transcriptCard.identitySize).toBe(
      obsidianTheme.buzz.transcriptCard.identitySize,
    );
  });
});
