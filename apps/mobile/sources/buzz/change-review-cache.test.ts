import { beforeEach, describe, expect, it, vi } from 'vitest';

const mmkvStores = vi.hoisted(() => new Map<string, Map<string, string>>());

vi.mock('react-native-mmkv', () => ({
  MMKV: class {
    private readonly values: Map<string, string>;

    constructor(options?: { id?: string }) {
      const id = options?.id ?? 'default';
      this.values = mmkvStores.get(id) ?? new Map<string, string>();
      mmkvStores.set(id, this.values);
    }

    getString(key: string) {
      return this.values.get(key);
    }

    set(key: string, value: string) {
      this.values.set(key, value);
    }

    delete(key: string) {
      this.values.delete(key);
    }
  },
}));

beforeEach(() => {
  mmkvStores.clear();
  vi.resetModules();
});

describe('change review cache', () => {
  it('restores a complete manifest and requested patch after an app restart', async () => {
    const first = await import('./change-review-cache');
    const tip = 'a'.repeat(40);
    first.cacheCompleteReviewManifest('corner-1', tip, [
      { path: 'src/app.ts', status: 'modified' },
    ]);
    first.cacheReviewPatch('corner-1', tip, 'src/app.ts', { content: '-old\n+new' });

    vi.resetModules();
    const restarted = await import('./change-review-cache');
    expect(restarted.readCachedReviewGeneration('corner-1', tip)).toMatchObject({
      sessionId: 'corner-1',
      tip,
      files: [{ path: 'src/app.ts', status: 'modified' }],
      patches: { 'src/app.ts': { content: '-old\n+new' } },
    });
  });

  it('selects the previous complete tip while excluding a preparing tip', async () => {
    const cache = await import('./change-review-cache');
    const previousTip = 'b'.repeat(40);
    const currentTip = 'c'.repeat(40);
    cache.cacheCompleteReviewManifest('corner-2', previousTip, [
      { path: 'previous.ts', status: 'modified' },
    ]);

    expect(cache.readLatestCachedReviewGeneration('corner-2', currentTip)?.tip).toBe(previousTip);
  });
});
