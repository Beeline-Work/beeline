import { describe, expect, it } from 'vitest';
import { webStringStorage } from './browser-string-storage';

describe('web settings persistence', () => {
  it('uses the synchronous browser storage contract without MMKV', () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    } as unknown as Storage;
    const web = webStringStorage(storage);
    web.set('settings', '{"ok":true}');
    expect(web.getString('settings')).toBe('{"ok":true}');
    web.delete('settings');
    expect(web.getString('settings')).toBeUndefined();
    expect(web.getAllKeys()).toEqual([]);
  });
});
