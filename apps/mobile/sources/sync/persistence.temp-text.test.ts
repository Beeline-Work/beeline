import { beforeEach, describe, expect, it, vi } from 'vitest';

const storage = vi.hoisted(() => new Map<string, string>());

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
vi.mock('react-native-mmkv', () => ({
  MMKV: class {
    getString(key: string) {
      return storage.get(key);
    }
    set(key: string, value: string | number | boolean) {
      storage.set(key, String(value));
    }
    delete(key: string) {
      storage.delete(key);
    }
    getAllKeys() {
      return [...storage.keys()];
    }
  },
}));

import { retrieveTempText, storeTempText } from './persistence';

describe('temporary text selection storage', () => {
  beforeEach(() => storage.clear());

  it('stages text under an opaque id and consumes it once', () => {
    const id = storeTempText('part of this message');
    expect(id).not.toBe('part of this message');
    expect(retrieveTempText(id)).toBe('part of this message');
    expect(retrieveTempText(id)).toBeNull();
  });
});
