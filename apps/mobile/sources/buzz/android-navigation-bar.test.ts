import { expect, it, vi } from 'vitest';
const setButtonStyleAsync = vi.hoisted(() => vi.fn(async (_style: string) => {}));
vi.mock('expo-modules-core', () => ({ requireNativeModule: () => ({ setButtonStyleAsync }) }));
import { setAndroidNavigationBarStyle } from './android-navigation-bar';

it('MOBILE-5 settles styling after the Android activity closes and can style the next activity', async () => {
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const closed = new Error('The current activity is no longer available');
  setButtonStyleAsync.mockRejectedValueOnce(closed);
  try {
    await expect(setAndroidNavigationBarStyle('dark')).resolves.toBeUndefined();
    expect(warning).toHaveBeenCalledWith('Could not style the Android navigation bar', closed);
    await setAndroidNavigationBarStyle('light');
    expect(setButtonStyleAsync.mock.calls).toEqual([['light'], ['dark']]);
  } finally { warning.mockRestore(); }
});
