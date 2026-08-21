import { describe, expect, it } from 'vitest';
import { localSettingsDefaults, localSettingsParse, THEME_PREFERENCES } from './localSettings';

describe('device-local appearance theme', () => {
  it('defaults new devices to Obsidian Refined', () => {
    expect(localSettingsDefaults.themePreference).toBe('obsidian');
    expect(THEME_PREFERENCES).toEqual(['obsidian', 'editorial', 'ledger']);
  });

  it('persists every shipped theme without affecting other local settings', () => {
    for (const themePreference of THEME_PREFERENCES) {
      expect(localSettingsParse({ themePreference, zenMode: true })).toMatchObject({
        themePreference,
        zenMode: true,
      });
    }
  });

  it('migrates every retired light/dark/adaptive choice to Obsidian', () => {
    for (const themePreference of ['light', 'dark', 'adaptive']) {
      expect(localSettingsParse({ themePreference, debugMode: true })).toMatchObject({
        themePreference: 'obsidian',
        debugMode: true,
      });
    }
  });
});
