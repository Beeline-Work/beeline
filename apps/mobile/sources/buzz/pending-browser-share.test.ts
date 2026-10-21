import { beforeEach, expect, it, vi } from 'vitest';
const data = vi.hoisted(() => new Map<string, string>());
vi.mock('@react-native-async-storage/async-storage', () => ({ default: {
  setItem: async (key: string, value: string) => { data.set(key, value); },
  getItem: async (key: string) => data.get(key) ?? null,
  removeItem: async (key: string) => { data.delete(key); },
} }));
import { savePendingBrowserShare, takePendingBrowserShare } from './pending-browser-share';
beforeEach(() => { data.clear(); vi.restoreAllMocks(); });
it('resumes a share once after sign-in and stores no viewer capability', async () => {
  const id = 'a'.repeat(43);
  await savePendingBrowserShare(id);
  expect(JSON.parse([...data.values()][0]!)).toEqual({ id, at: expect.any(Number) });
  expect(await takePendingBrowserShare()).toBe(id);
  expect(await takePendingBrowserShare()).toBeNull();
});
it('discards old and malformed navigation targets', async () => {
  await savePendingBrowserShare('//example.com');
  expect(data.size).toBe(0);
  vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValue(3_600_001);
  await savePendingBrowserShare('a'.repeat(43));
  expect(await takePendingBrowserShare()).toBeNull();
});
