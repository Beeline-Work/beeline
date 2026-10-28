import { beforeEach, describe, expect, it, vi } from 'vitest';

// theme.ts reads react-native's Platform.select at import time.
vi.mock('react-native', () => ({
  Platform: { OS: 'android', select: (choices: Record<string, unknown>) => choices.default },
  Appearance: { getColorScheme: () => scheme.value, addChangeListener: (listener: () => void) => { scheme.listener = listener; return { remove() {} }; } },
}));

const scheme = vi.hoisted(() => ({ value: 'dark' as 'light' | 'dark' | null, listener: () => {} }));
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

const setNavigationBarStyle = vi.fn();
vi.mock('expo-navigation-bar', () => ({ setStyle: setNavigationBarStyle }));

const setAndroidNightMode = vi.hoisted(() => vi.fn());
vi.mock('./buzz/android-launch-appearance-native', () => ({
  setAndroidNightMode,
}));

describe('the appearance toggle wired into Unistyles', () => {
  beforeEach(async () => {
    vi.resetModules();
    const { Platform } = await import('react-native');
    Object.assign(Platform, { OS: 'android' });
    mmkvValues.clear();
    scheme.value = 'dark';
    configure.mockClear();
    setTheme.mockClear();
    setRootViewBackgroundColor.mockClear();
    setBackgroundColorAsync.mockClear();
    setNavigationBarStyle.mockClear();
    setAndroidNightMode.mockReset();
  });

  it('maps obsidian to light navigation buttons and bone to dark ones', async () => {
    const { navigationBarStyleForTheme } = await import('./unistyles');
    for (const name of ['obsidian', 'obsidianSmall', 'obsidianLarge'] as const) {
      expect(navigationBarStyleForTheme(name)).toBe('dark');
    }
    for (const name of ['bone', 'boneSmall', 'boneLarge'] as const) {
      expect(navigationBarStyleForTheme(name)).toBe('light');
    }
  });

  it('styles the Android navigation bar at cold start and on every theme change', async () => {
    const { setAppDisplay } = await import('./unistyles');
    expect(setNavigationBarStyle).toHaveBeenLastCalledWith('dark');

    setAppDisplay('light', 'small');
    expect(setNavigationBarStyle).toHaveBeenLastCalledWith('light');

    setAppDisplay('dark', 'large');
    expect(setNavigationBarStyle).toHaveBeenLastCalledWith('dark');
  });

  it('leaves the navigation bar alone off Android', async () => {
    const { Platform } = await import('react-native');
    Object.assign(Platform, { OS: 'ios' });
    const { setAppDisplay } = await import('./unistyles');
    setAppDisplay('light', 'medium');
    expect(setNavigationBarStyle).not.toHaveBeenCalled();
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
    mmkvValues.set('appearance-system-v1', 'done');
    mmkvValues.set('appearance-launch', 'light');
    mmkvValues.set('local-settings', JSON.stringify({ appearance: 'light' }));
    await import('./unistyles');

    const config = configure.mock.calls[0][0];
    expect(config.settings.initialTheme).toBe('bone');
  });

  it('cold-starts native text at the persisted small or large size', async () => {
    mmkvValues.set('appearance-launch', 'dark');
    mmkvValues.set('local-settings', JSON.stringify({ appearance: 'dark', uiSize: 'small' }));
    await import('./unistyles');
    expect(configure.mock.calls[0][0].settings.initialTheme).toBe('obsidianSmall');
  });

  it('setAppAppearance flips the live Unistyles theme and the native root color', async () => {
    const { boneTheme } = await import('./theme');
    const { setAppAppearance } = await import('./unistyles');
    setAndroidNightMode.mockClear();

    setAppAppearance('light', 'large');

    expect(setTheme).toHaveBeenCalledWith('boneLarge');
    expect(setRootViewBackgroundColor).toHaveBeenCalledWith(boneTheme.colors.groupped.background);
    expect(setBackgroundColorAsync).toHaveBeenCalledWith(boneTheme.colors.groupped.background);
    expect(setAndroidNightMode).not.toHaveBeenCalled();
  });

  it('clears the old Android splash pin when migrating to System', async () => {
    mmkvValues.set('appearance-launch', 'dark');
    await import('./unistyles');

    expect(setAndroidNightMode).toHaveBeenCalledWith('system');
  });

  it('re-pins the next Android splash when Appearance is chosen', async () => {
    const { applyAppearanceChoice, setAppDisplay } = await import('./unistyles');
    setAndroidNightMode.mockClear();

    setAppDisplay('light', 'medium');
    expect(setAndroidNightMode).not.toHaveBeenCalled();

    applyAppearanceChoice('light', 'medium');
    expect(setAndroidNightMode).toHaveBeenCalledWith('light');
  });

  it('catches the OS change emitted while clearing an old Android override', async () => {
    setAndroidNightMode.mockImplementationOnce(() => {
      scheme.value = 'light';
      scheme.listener();
    });
    await import('./unistyles');
    expect(setTheme).toHaveBeenLastCalledWith('bone');
  });

  for (const platform of ['ios', 'android', 'web']) {
    it(`follows live system changes on ${platform}, preserving explicit choices and text size`, async () => {
      const { Platform } = await import('react-native');
      Object.assign(Platform, { OS: platform });
      const { applyAppearanceChoice, setAppDisplay } = await import('./unistyles');
      setAppDisplay('system', 'large');
      scheme.value = 'light';
      scheme.listener();
      expect(setTheme).toHaveBeenLastCalledWith(platform === 'web' ? 'bone' : 'boneLarge');
      scheme.value = 'dark';
      scheme.listener();
      expect(setTheme).toHaveBeenLastCalledWith(platform === 'web' ? 'obsidian' : 'obsidianLarge');
      applyAppearanceChoice('light', 'large');
      setTheme.mockClear();
      scheme.listener();
      expect(setTheme).not.toHaveBeenCalled();
      applyAppearanceChoice('system', 'large');
      scheme.value = null;
      scheme.listener();
      expect(setTheme).toHaveBeenLastCalledWith(platform === 'web' ? 'bone' : 'boneLarge');
    });
  }
});
