import { describe, expect, it } from 'vitest';
import { webStringStorage } from './browser-string-storage';

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
    clear: () => values.clear(),
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
  };
}

describe('web string storage', () => {
  it('does not bring back a key another tab removed', () => {
    const origin = memoryStorage();
    const thisTab = webStringStorage(origin, 'beeline.surface.');
    const otherTab = webStringStorage(origin, 'beeline.surface.');
    thisTab.set('surface.room', 'old account');

    otherTab.delete('surface.room');

    expect(thisTab.getString('surface.room')).toBeUndefined();
    expect(thisTab.getAllKeys()).toEqual([]);
  });

  it('keeps values in memory only where the browser gives no storage', () => {
    const none = webStringStorage(undefined, 'beeline.settings.');
    none.set('settings', '{"ok":true}');
    expect(none.getString('settings')).toBe('{"ok":true}');
    expect(none.getAllKeys()).toEqual(['settings']);
    none.delete('settings');
    expect(none.getString('settings')).toBeUndefined();
  });
});
