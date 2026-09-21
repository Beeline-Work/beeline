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

describe('seeding the app appearance from the system', () => {
  beforeEach(() => {
    vi.resetModules();
    mmkvValues.clear();
    colorScheme.value = 'light';
  });

  it('seeds light on a fresh install on a light system', async () => {
    const { seedAppAppearanceFromSystem } = await import('./app-appearance-seed');

    expect(seedAppAppearanceFromSystem()).toBe('light');
    expect(JSON.parse(mmkvValues.get('local-settings')!)).toMatchObject({ appearance: 'light' });
  });

  it('seeds dark on a fresh install on a dark system', async () => {
    colorScheme.value = 'dark';
    const { seedAppAppearanceFromSystem } = await import('./app-appearance-seed');

    expect(seedAppAppearanceFromSystem()).toBe('dark');
    expect(JSON.parse(mmkvValues.get('local-settings')!)).toMatchObject({ appearance: 'dark' });
  });

  it('follows a later system change when nothing was chosen', async () => {
    mmkvValues.set('local-settings', JSON.stringify({ appearance: 'dark' }));
    colorScheme.value = 'light';
    const { seedAppAppearanceFromSystem } = await import('./app-appearance-seed');

    expect(seedAppAppearanceFromSystem()).toBe('light');
    expect(JSON.parse(mmkvValues.get('local-settings')!)).toMatchObject({ appearance: 'light' });
  });

  it('never seeds over an explicit choice', async () => {
    mmkvValues.set('appearance-launch', 'dark');
    mmkvValues.set('local-settings', JSON.stringify({ appearance: 'dark' }));
    colorScheme.value = 'light';
    const { seedAppAppearanceFromSystem } = await import('./app-appearance-seed');

    expect(seedAppAppearanceFromSystem()).toBe('dark');
    expect(JSON.parse(mmkvValues.get('local-settings')!)).toMatchObject({ appearance: 'dark' });
  });
});
