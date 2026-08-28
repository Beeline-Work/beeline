import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

const mmkv = vi.hoisted(() => {
  const stores = new Map<string, Map<string, string>>();
  const reads: Array<{ id: string; key: string }> = [];
  return { stores, reads };
});

vi.mock('react-native-mmkv', () => ({
  MMKV: class {
    private readonly values: Map<string, string>;
    private readonly id: string;

    constructor({ id }: { id: string }) {
      this.id = id;
      this.values = mmkv.stores.get(id) ?? new Map<string, string>();
      mmkv.stores.set(id, this.values);
    }

    getString(key: string) {
      mmkv.reads.push({ id: this.id, key });
      return this.values.get(key);
    }

    set(key: string, value: string) {
      this.values.set(key, value);
    }

    delete(key: string) {
      this.values.delete(key);
    }

    getAllKeys() {
      return [...this.values.keys()];
    }
  },
}));

import {
  clearMobileSurfaceStorage,
  mobileSurfaceCache,
  surfaceAddress,
} from './surface-storage';
import { isRoomView, surfaceCacheKey } from '@beeline/buzz-client';

const LEGACY_STORE = 'buzz-local-cache';
const LEGACY_KEY = 'buzz-local-cache-v3';
const legacyFixture = readFileSync(
  new URL('./fixtures/surface-storage-upgrade/v3-release-0.2.18.json', import.meta.url),
  'utf8',
);

describe('STATE-UPGRADE gate — server-indexed surface storage', () => {
  it('boots beside the release-v3 WorkspaceSnapshot without reading or rewriting it', async () => {
    const legacy = mmkv.stores.get(LEGACY_STORE) ?? new Map<string, string>();
    legacy.set(LEGACY_KEY, legacyFixture);
    mmkv.stores.set(LEGACY_STORE, legacy);
    mmkv.reads.length = 0;

    await expect(
      mobileSurfaceCache.read(
        surfaceAddress(
          'https://usebeeline.app',
          'a'.repeat(64),
          '/room/7d111868-52eb-43ab-98ae-8a6c49b92da8',
        ),
        isRoomView,
      ),
    ).resolves.toBeNull();
    clearMobileSurfaceStorage();

    // The new response and outbox namespaces start empty. The retired v3
    // snapshot is deliberately inert—not decoded, migrated, or treated as
    // Room truth—and remains available for rollback instead of crashing boot.
    expect(mmkv.reads.some((read) => read.id === LEGACY_STORE)).toBe(false);
    expect(mmkv.stores.get(LEGACY_STORE)?.get(LEGACY_KEY)).toBe(legacyFixture);
  });

  it('evicts malformed data written under the new response contract', async () => {
    const responseStore = mmkv.stores.get('buzz-surface-responses')!;
    const address = surfaceAddress(
      'https://usebeeline.app',
      'b'.repeat(64),
      '/room/80a5a6f1-fb5a-493b-93eb-f3db33f696e6',
    );
    const key = `surface.${encodeURIComponent(surfaceCacheKey(address))}`;
    responseStore.set(key, '{not-json');

    await expect(mobileSurfaceCache.read(address, isRoomView)).resolves.toBeNull();

    expect(responseStore.has(key)).toBe(false);
    expect(mmkv.stores.get(LEGACY_STORE)?.get(LEGACY_KEY)).toBe(legacyFixture);
  });
});
