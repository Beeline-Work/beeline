import { describe, expect, it } from 'vitest';

const appConfig = (await import('../../app.config.js')).default.expo;

describe('Android navigation bar config', () => {
  it('turns off the contrast scrim so the bar shows the app background', () => {
    const plugin = appConfig.plugins.find(
      (entry: unknown) => Array.isArray(entry) && entry[0] === 'expo-navigation-bar',
    ) as [string, { enforceContrast?: boolean }] | undefined;
    expect(plugin).toBeDefined();
    expect(plugin?.[1].enforceContrast).toBe(false);
  });
});
