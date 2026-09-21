import { beforeEach, describe, expect, it, vi } from 'vitest';

const mmkvValues = vi.hoisted(() => new Map<string, string>());
const setAndroidNightMode = vi.hoisted(() => vi.fn());

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
}));

vi.mock('./android-launch-appearance-native', () => ({
  setAndroidNightMode,
}));

describe('Android launch appearance follows the effective appearance', () => {
  beforeEach(() => {
    vi.resetModules();
    mmkvValues.clear();
    setAndroidNightMode.mockReset();
  });

  it('pins the default dark on a cold start that never opened Appearance', async () => {
    const { applyEffectiveAndroidLaunchAppearance } = await import('./android-launch-appearance');

    applyEffectiveAndroidLaunchAppearance();

    expect(setAndroidNightMode).toHaveBeenCalledTimes(1);
    expect(setAndroidNightMode).toHaveBeenCalledWith('dark');
  });

  it('pins light on a cold start after a light choice', async () => {
    mmkvValues.set('local-settings', JSON.stringify({ appearance: 'light' }));
    const { applyEffectiveAndroidLaunchAppearance } = await import('./android-launch-appearance');

    applyEffectiveAndroidLaunchAppearance();

    expect(setAndroidNightMode).toHaveBeenCalledWith('light');
  });

  it('pins dark on a cold start after a dark choice', async () => {
    mmkvValues.set('local-settings', JSON.stringify({ appearance: 'dark' }));
    const { applyEffectiveAndroidLaunchAppearance } = await import('./android-launch-appearance');

    applyEffectiveAndroidLaunchAppearance();

    expect(setAndroidNightMode).toHaveBeenCalledWith('dark');
  });

  it('reads the persisted effective appearance, never a stale launch key', async () => {
    // The retired 'appearance-launch' key has one authority: local settings.
    // A leftover value must not outvote the appearance the app renders.
    mmkvValues.set('appearance-launch', 'light');
    mmkvValues.set('local-settings', JSON.stringify({ appearance: 'dark' }));
    const { applyEffectiveAndroidLaunchAppearance } = await import('./android-launch-appearance');

    applyEffectiveAndroidLaunchAppearance();

    expect(setAndroidNightMode).toHaveBeenCalledWith('dark');
  });

  it('pins the chosen appearance from the Settings → Appearance write path', async () => {
    const { pinAndroidLaunchAppearance } = await import('./android-launch-appearance');

    pinAndroidLaunchAppearance('light');

    expect(setAndroidNightMode).toHaveBeenCalledTimes(1);
    expect(setAndroidNightMode).toHaveBeenCalledWith('light');
  });

  it('reapplies a choice killed mid-switch on the next cold start', async () => {
    // The caller commits the choice to local settings before this native call,
    // so a throw here still leaves the following cold start correct.
    mmkvValues.set('local-settings', JSON.stringify({ appearance: 'light' }));
    setAndroidNightMode.mockImplementation(() => {
      throw new Error('killed');
    });
    const { pinAndroidLaunchAppearance } = await import('./android-launch-appearance');

    expect(() => pinAndroidLaunchAppearance('light')).toThrow('killed');

    setAndroidNightMode.mockReset();
    vi.resetModules();
    const { applyEffectiveAndroidLaunchAppearance } = await import('./android-launch-appearance');
    applyEffectiveAndroidLaunchAppearance();
    expect(setAndroidNightMode).toHaveBeenCalledWith('light');
  });
});
