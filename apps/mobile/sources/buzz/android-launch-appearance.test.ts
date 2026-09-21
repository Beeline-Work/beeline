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

describe('Android launch appearance pin', () => {
  beforeEach(() => {
    vi.resetModules();
    mmkvValues.clear();
    setAndroidNightMode.mockReset();
  });

  it('pins an explicit choice on a cold start', async () => {
    mmkvValues.set('appearance-launch', 'light');
    const { applyEffectiveAndroidLaunchAppearance } = await import('./android-launch-appearance');

    applyEffectiveAndroidLaunchAppearance();

    expect(setAndroidNightMode).toHaveBeenCalledTimes(1);
    expect(setAndroidNightMode).toHaveBeenCalledWith('light');
  });

  it('leaves a never-chosen splash following the system', async () => {
    mmkvValues.set('local-settings', JSON.stringify({ appearance: 'dark' }));
    const { applyEffectiveAndroidLaunchAppearance } = await import('./android-launch-appearance');

    applyEffectiveAndroidLaunchAppearance();

    expect(setAndroidNightMode).not.toHaveBeenCalled();
  });

  it('records an explicit choice before pinning it', async () => {
    const { pinAndroidLaunchAppearance } = await import('./android-launch-appearance');

    pinAndroidLaunchAppearance('light');

    expect(mmkvValues.get('appearance-launch')).toBe('light');
    expect(setAndroidNightMode).toHaveBeenCalledWith('light');
  });

  it('records a choice killed mid-switch for the next cold start', async () => {
    setAndroidNightMode.mockImplementation(() => {
      throw new Error('killed');
    });
    const { pinAndroidLaunchAppearance } = await import('./android-launch-appearance');

    expect(() => pinAndroidLaunchAppearance('light')).toThrow('killed');
    // The choice marker is what protects the value from later system seeding.
    expect(mmkvValues.get('appearance-launch')).toBe('light');
  });
});
