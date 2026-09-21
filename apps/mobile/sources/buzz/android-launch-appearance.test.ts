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
  beforeEach(async () => {
    vi.resetModules();
    mmkvValues.clear();
    setAndroidNightMode.mockReset();
  });

  it('does not force a splash theme until Appearance is actually chosen', async () => {
    const { applyPersistedAndroidLaunchAppearance, currentAppearanceLaunch } = await import(
      './android-launch-appearance'
    );

    expect(currentAppearanceLaunch()).toBe('system');
    applyPersistedAndroidLaunchAppearance();
    expect(setAndroidNightMode).not.toHaveBeenCalled();
  });

  it('treats an unknown launch pin as system-following', async () => {
    mmkvValues.set('appearance-launch', 'auto');
    const { applyPersistedAndroidLaunchAppearance, currentAppearanceLaunch } = await import(
      './android-launch-appearance'
    );

    expect(currentAppearanceLaunch()).toBe('system');
    applyPersistedAndroidLaunchAppearance();
    expect(setAndroidNightMode).not.toHaveBeenCalled();
  });

  it('does not treat the default stored appearance as a launch pin', async () => {
    mmkvValues.set('local-settings', JSON.stringify({ appearance: 'dark' }));
    const { applyPersistedAndroidLaunchAppearance, currentAppearanceLaunch } = await import(
      './android-launch-appearance'
    );

    expect(currentAppearanceLaunch()).toBe('system');
    applyPersistedAndroidLaunchAppearance();
    expect(setAndroidNightMode).not.toHaveBeenCalled();
  });

  it('pins light so the next splash uses the cream day resources', async () => {
    const { pinAndroidLaunchAppearance, applyPersistedAndroidLaunchAppearance, currentAppearanceLaunch } =
      await import('./android-launch-appearance');

    pinAndroidLaunchAppearance('light');

    expect(currentAppearanceLaunch()).toBe('light');
    expect(setAndroidNightMode).toHaveBeenCalledTimes(1);
    expect(setAndroidNightMode).toHaveBeenCalledWith('light');

    setAndroidNightMode.mockClear();
    applyPersistedAndroidLaunchAppearance();
    expect(setAndroidNightMode).toHaveBeenCalledWith('light');
  });

  it('pins dark so the next splash uses the aubergine night resources', async () => {
    const { pinAndroidLaunchAppearance, currentAppearanceLaunch } = await import(
      './android-launch-appearance'
    );

    pinAndroidLaunchAppearance('dark');

    expect(currentAppearanceLaunch()).toBe('dark');
    expect(setAndroidNightMode).toHaveBeenCalledWith('dark');
  });

  it('writes the pin before the native call so a kill mid-switch still reapplies', async () => {
    setAndroidNightMode.mockImplementation(() => {
      throw new Error('killed');
    });
    const { pinAndroidLaunchAppearance } = await import('./android-launch-appearance');

    expect(() => pinAndroidLaunchAppearance('light')).toThrow('killed');
    expect(mmkvValues.get('appearance-launch')).toBe('light');

    setAndroidNightMode.mockReset();
    vi.resetModules();
    const { applyPersistedAndroidLaunchAppearance } = await import('./android-launch-appearance');
    applyPersistedAndroidLaunchAppearance();
    expect(setAndroidNightMode).toHaveBeenCalledWith('light');
  });
});
