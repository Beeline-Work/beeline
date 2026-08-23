import { describe, expect, it, vi } from 'vitest';

// theme.ts reads react-native's Platform.select at import time.
vi.mock('react-native', () => ({
  Platform: { OS: 'android', select: (choices: Record<string, unknown>) => choices.default },
}));

import { beelineThemes } from './buzz/groknight';
import { editorialTheme, ledgerTheme, obsidianTheme } from './theme';

const bridged = [obsidianTheme, editorialTheme, ledgerTheme];

describe('the legacy-theme bridge carries the Speakeasy language to lesser screens', () => {
  it('maps every Beeline theme onto the app canvas and brass accent', () => {
    for (const theme of bridged) {
      // The canvas: every screen that reads legacy background tokens still
      // lands on the Speakeasy aubergine, never on the old graphite/black.
      expect(theme.colors.surface).toBe(theme.buzz.bgBase);
      expect(theme.colors.groupped.background).toBe(theme.buzz.bgTerminal);
      expect(theme.colors.header.background).toBe(theme.buzz.bgBase);
    }
    expect(obsidianTheme.buzz.name).toBe('obsidian');
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

  it('keeps every theme prose ladder readable from the bridge', () => {
    for (const theme of bridged) {
      expect(theme.buzz.proseRegular).toBeTruthy();
      expect(theme.buzz.proseSemibold).toBeTruthy();
    }
    // The obsidian ladder is Space Grotesk — the transcript family — which is
    // what the lesser screens now read instead of hardwired Plex Sans.
    expect(beelineThemes.obsidian.proseRegular).toBe('SpaceGrotesk-Regular');
    expect(beelineThemes.obsidian.proseSemibold).toBe('SpaceGrotesk-SemiBold');
  });
});
