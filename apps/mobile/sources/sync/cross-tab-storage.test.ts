import { describe, expect, it, vi } from 'vitest';
import { surfaceCacheKey } from '@beeline/buzz-client';

/** One origin's localStorage shared by two tabs; this tab only hears the other's writes as events. */
const browser = vi.hoisted(() => {
  const values = new Map<string, string>();
  const listeners: Array<(event: unknown) => void> = [];
  const localStorage = {
    get length() { return values.size; },
    key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, String(value)); },
    removeItem: (key: string) => { values.delete(key); },
    clear: () => values.clear(),
  };
  Object.assign(globalThis, {
    localStorage,
    window: {
      document: {},
      addEventListener: (type: string, listener: (event: unknown) => void) => {
        if (type === 'storage') listeners.push(listener);
      },
      removeEventListener: () => undefined,
    },
  });
  return {
    /** Another tab writes `key` (or removes it when `value` is null). */
    otherTab(key: string | null, value: string | null) {
      if (key === null) values.clear();
      else if (value === null) values.delete(key);
      else values.set(key, value);
      for (const listener of listeners) listener({ storageArea: localStorage, key, newValue: value });
    },
  };
});
vi.mock('react-native-mmkv', () => ({ MMKV: class {} }));

import { mobileSurfaceCache, surfaceAddress } from '@/buzz/surface-storage';
import { storage } from './storage';

const isCount = (value: unknown): value is { count: number } =>
  typeof value === 'object' && value !== null && typeof (value as { count?: unknown }).count === 'number';
const first = surfaceAddress('https://server.test', 'viewer', '/workspaces');
const second = surfaceAddress('https://server.test', 'viewer', '/workspace/:id', { workspaceId: 'ws' });
const storedKey = (address: typeof first) =>
  `beeline.surface.surface.${encodeURIComponent(surfaceCacheKey(address))}`;

describe('another tab\'s storage writes', () => {
  it('reach this tab\'s hot copy of that surface and no other', async () => {
    await mobileSurfaceCache.write(first, { count: 1 }, isCount);
    await mobileSurfaceCache.write(second, { count: 5 }, isCount);
    browser.otherTab(storedKey(first), JSON.stringify({ count: 2 }));
    expect(mobileSurfaceCache.peek(first, isCount)).toEqual({ count: 2 });
    browser.otherTab(storedKey(first), null);
    expect(mobileSurfaceCache.peek(first, isCount)).toBeNull();
    expect(mobileSurfaceCache.peek(second, isCount)).toEqual({ count: 5 });
  });

  it('drop every hot surface when the other tab clears the storage', async () => {
    await mobileSurfaceCache.write(second, { count: 5 }, isCount);
    browser.otherTab(null, null);
    expect(mobileSurfaceCache.peek(second, isCount)).toBeNull();
  });

  it('reach this tab\'s settings', () => {
    browser.otherTab('beeline.settings.settings',
      JSON.stringify({ settings: { userMessageBubbleColor: 'blue' }, version: 1 }));
    expect(storage.getState().settings.userMessageBubbleColor).toBe('blue');
    browser.otherTab('beeline.settings.local-settings', JSON.stringify({ zenMode: true }));
    expect(storage.getState().localSettings.zenMode).toBe(true);
  });
});
