import { beforeEach, describe, expect, it, vi } from 'vitest';

// theme.ts reads react-native's Platform.select at import time.
vi.mock('react-native', () => ({
  Platform: { OS: 'android', select: (choices: Record<string, unknown>) => choices.default },
}));

const mmkvValues = vi.hoisted(() => new Map<string, string>());
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

const configure = vi.fn();
const setTheme = vi.fn();
const setRootViewBackgroundColor = vi.fn();
vi.mock('react-native-unistyles', () => ({
  StyleSheet: { configure },
  UnistylesRuntime: { setTheme, setRootViewBackgroundColor },
}));

const setBackgroundColorAsync = vi.fn();
vi.mock('expo-system-ui', () => ({ setBackgroundColorAsync }));

const setAndroidNightMode = vi.hoisted(() => vi.fn());
vi.mock('./buzz/android-launch-appearance-native', () => ({
  setAndroidNightMode,
}));

describe('the appearance toggle wired into Unistyles', () => {
  beforeEach(() => {
    vi.resetModules();
    mmkvValues.clear();
    configure.mockClear();
    setTheme.mockClear();
    setRootViewBackgroundColor.mockClear();
    setBackgroundColorAsync.mockClear();
    setAndroidNightMode.mockClear();
  });

  it('registers both obsidian and bone, defaulting cold start to obsidian', async () => {
    const {
      obsidianTheme,
      obsidianSmallTheme,
      obsidianLargeTheme,
      boneTheme,
      boneSmallTheme,
      boneLargeTheme,
    } = await import('./theme');
    await import('./unistyles');

    expect(configure).toHaveBeenCalledTimes(1);
    const config = configure.mock.calls[0][0];
    expect(config.themes.obsidian).toBe(obsidianTheme);
    expect(config.themes.obsidianSmall).toBe(obsidianSmallTheme);
    expect(config.themes.obsidianLarge).toBe(obsidianLargeTheme);
    expect(config.themes.bone).toBe(boneTheme);
    expect(config.themes.boneSmall).toBe(boneSmallTheme);
    expect(config.themes.boneLarge).toBe(boneLargeTheme);
    expect(config.settings.initialTheme).toBe('obsidian');
    expect(setRootViewBackgroundColor).toHaveBeenCalledWith(obsidianTheme.colors.groupped.background);
  });

  it('cold-starts into bone when the persisted appearance is light', async () => {
    mmkvValues.set('local-settings', JSON.stringify({ appearance: 'light' }));
    await import('./unistyles');

    const config = configure.mock.calls[0][0];
    expect(config.settings.initialTheme).toBe('bone');
  });

  it('cold-starts native text at the persisted small or large size', async () => {
    mmkvValues.set('local-settings', JSON.stringify({ appearance: 'dark', uiSize: 'small' }));
    await import('./unistyles');
    expect(configure.mock.calls[0][0].settings.initialTheme).toBe('obsidianSmall');
  });

  it('setAppAppearance flips the live Unistyles theme and the native root color', async () => {
    const { boneTheme } = await import('./theme');
    const { setAppAppearance } = await import('./unistyles');

    setAppAppearance('light', 'large');

    expect(setTheme).toHaveBeenCalledWith('boneLarge');
    expect(setRootViewBackgroundColor).toHaveBeenCalledWith(boneTheme.colors.groupped.background);
    expect(setBackgroundColorAsync).toHaveBeenCalledWith(boneTheme.colors.groupped.background);
    expect(setAndroidNightMode).not.toHaveBeenCalled();
  });

  it('pins the next Android splash only when Appearance is chosen', async () => {
    const { applyAppearanceChoice, setAppDisplay } = await import('./unistyles');

    setAppDisplay('light', 'medium');
    expect(setAndroidNightMode).not.toHaveBeenCalled();

    applyAppearanceChoice('light', 'medium');
    expect(setAndroidNightMode).toHaveBeenCalledWith('light');
    expect(mmkvValues.get('appearance-launch')).toBe('light');
  });
});
