import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native-mmkv', () => ({
  MMKV: class {
    getString() {
      return undefined;
    }
    set() {}
    delete() {}
  },
}));

import manifest from './fixtures/read-model-cache/manifest.json';
import { BUZZ_CACHE_VERSION, channelCacheKey, decodePersistedBuzzCache } from './local-cache';

const fixturesRoot = fileURLToPath(new URL('./fixtures/read-model-cache/', import.meta.url));

describe('STATE-UPGRADE gate — mobile read-model cache', () => {
  it('keeps a golden fixture for the current persisted version', () => {
    expect(manifest.currentVersion).toBe(BUZZ_CACHE_VERSION);
    expect(manifest.fixtures.map((fixture) => fixture.version)).toContain(BUZZ_CACHE_VERSION);
  });

  it.each(manifest.fixtures)(
    'loads release $release cache v$version through the current decoder',
    async ({ file }) => {
      const serialized = await readFile(`${fixturesRoot}${file}`, 'utf8');
      const restored = decodePersistedBuzzCache(serialized);
      expect(restored.bootIntegrityHalt).toBeNull();
      const channel = restored.channels[channelCacheKey('fixture-viewer', 'fixture-room')];
      expect(channel?.snapshot?.schemaVersion).toBe(1);
      expect(channel?.snapshot?.workspaceId).toBe('fixture-workspace');
    },
  );
});
