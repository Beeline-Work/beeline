import { beforeEach, describe, expect, it, vi } from 'vitest';

const mmkvValues = vi.hoisted(() => new Map<string, string>());
const colorScheme = vi.hoisted(() => ({ value: 'light' as 'light' | 'dark' | null }));

vi.mock('react-native-mmkv', () => ({
  MMKV: class {
    getString(key: string) {
      return mmkvValues.get(key);
    }
    set(key: string, value: string) {
      mmkvValues.set(key, value);
    }
  },
}));

vi.mock('react-native', () => ({
  Platform: { OS: 'android' },
  Appearance: { getColorScheme: () => colorScheme.value },
}));

describe('System appearance migration and resolution', () => {
  beforeEach(() => {
    vi.resetModules();
    mmkvValues.clear();
    colorScheme.value = 'light';
  });

  it.each(['light', 'dark'])('moves a stored %s choice to System exactly once', async (appearance) => {
    mmkvValues.set('appearance-launch', appearance);
    mmkvValues.set('local-settings', JSON.stringify({ appearance, uiSize: 'large' }));
    const { seedAppAppearanceFromSystem } = await import('./app-appearance-seed');
    const { loadLocalSettings, saveLocalSettings, saveAppearanceChoice } = await import('@/sync/persistence');
    seedAppAppearanceFromSystem();
    expect(loadLocalSettings()).toMatchObject({ appearance: 'system', uiSize: 'large' });
    saveLocalSettings({ ...loadLocalSettings(), appearance: 'dark' });
    saveAppearanceChoice('dark');
    vi.resetModules();
    const restarted = await import('./app-appearance-seed');
    expect(restarted.seedAppAppearanceFromSystem()).toBe('dark');
    expect(loadLocalSettings().appearance).toBe('dark');
  });

  it('defaults to System and resolves unknown OS preference to light', async () => {
    colorScheme.value = null;
    const { seedAppAppearanceFromSystem } = await import('./app-appearance-seed');
    expect(seedAppAppearanceFromSystem()).toBe('light');
    expect(JSON.parse(mmkvValues.get('local-settings')!).appearance).toBe('system');
  });
});
