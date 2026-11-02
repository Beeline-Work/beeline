import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  files: new Map<string, { text: string; size: number }>(), peak: 0, reads: vi.fn(), deleted: vi.fn(),
}));
const directory = 'file:///synthetic-cache/beeline-immutable-bytes-v1/';
vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
vi.mock('expo-file-system/legacy', () => ({
  cacheDirectory: 'file:///synthetic-cache/', EncodingType: { Base64: 'base64', UTF8: 'utf8' },
  makeDirectoryAsync: async () => {},
  getInfoAsync: async (uri: string) => mocks.files.has(uri) ? { exists: true, isDirectory: false, size: mocks.files.get(uri)!.size } : { exists: false },
  readDirectoryAsync: async (uri: string) => [...mocks.files.keys()].filter(key => key.startsWith(uri)).map(key => key.slice(uri.length)),
  readAsStringAsync: async (uri: string) => { mocks.reads(uri); const value = mocks.files.get(uri); if (!value) throw new Error('missing'); return value.text; },
  writeAsStringAsync: async (uri: string, text: string, options: { encoding: string }) => {
    const size = options.encoding === 'base64' ? text.length / 4 * 3 - (text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0) : new TextEncoder().encode(text).length;
    mocks.files.set(uri, { text: size > 1024 * 1024 ? '' : text, size });
    mocks.peak = Math.max(mocks.peak, [...mocks.files.values()].reduce((total, file) => total + file.size, 0));
  },
  moveAsync: async ({ from, to }: { from: string; to: string }) => { const value = mocks.files.get(from); if (!value) throw new Error('missing'); mocks.files.delete(from); mocks.files.set(to, value); },
  deleteAsync: async (uri: string) => { mocks.deleted(uri); for (const key of mocks.files.keys()) if (key === uri || uri.endsWith('/') && key.startsWith(uri)) mocks.files.delete(key); },
}));
import { createArtifactByteStore } from './artifact-byte-store';
const certificate = (scope: string, epoch: string) => ({ digest: 'a'.repeat(64), scopes: [{ authorityScope: scope, epoch }] });
beforeEach(() => { mocks.files.clear(); mocks.peak = 0; mocks.reads.mockClear(); mocks.deleted.mockClear(); });
describe('owned immutable native byte disk', () => {
  it('uses opaque immutable-key file names, round-trips bytes and removes crash leftovers', async () => {
    const store = createArtifactByteStore(() => ({ format: 'png' }));
    await store.set('principal/origin/object/version', new Uint8Array([1, 2, 3]));
    const uri = await store.localUri('principal/origin/object/version');
    expect(uri).toMatch(/\/beeline-immutable-bytes-v1\/[a-f0-9]{64}\.png$/);
    expect(await store.get('principal/origin/object/version')).toEqual(new Uint8Array([1, 2, 3]));
    mocks.files.set(`${directory}interrupted.next`, { text: 'leftover', size: 8 });
    const reopened = createArtifactByteStore(() => ({ format: 'png' }));
    expect(await reopened.get('principal/origin/object/version')).toEqual(new Uint8Array([1, 2, 3]));
    expect(mocks.files.has(`${directory}interrupted.next`)).toBe(false);
  });
  it('stats corrupted oversized files before reading or painting them', async () => {
    const store = createArtifactByteStore(() => ({ format: 'png' })); await store.set('key', new Uint8Array([1]));
    const uri = (await store.localUri('key'))!;
    mocks.files.set(uri, { text: '', size: 26 * 1024 * 1024 }); mocks.reads.mockClear();
    expect(await store.get('key')).toBeNull(); expect(mocks.reads).not.toHaveBeenCalledWith(uri);
    expect(mocks.files.has(uri)).toBe(false);
  });
  // This proof encodes actual 25MiB buffers; the longer budget covers bounded
  // CPU work under serialized Vitest3, not a network wait or relaxed limit.
  it('keeps resident plus atomic temporary bytes below128MiB, including same-key replacement', async () => {
    const store = createArtifactByteStore(); const bytes = new Uint8Array(25 * 1024 * 1024);
    for (let i = 0; i < 5; i++) await store.set(`key-${i}`, bytes);
    await store.set('key-0', bytes); // old file must leave before the new temp is written.
    await store.set('small', new Uint8Array(4 * 1024 * 1024));
    expect(mocks.peak).toBeLessThanOrEqual(128 * 1024 * 1024);
    expect(await store.localUri('key-1')).toBeNull(); expect(await store.localUri('key-0')).not.toBeNull();
    await expect(store.set('oversized', new Uint8Array(25 * 1024 * 1024 + 1))).rejects.toThrow('budget');
  }, 30_000);
  it('purges only the affected held authority at or below a removal fence; logout clears the owned partition', async () => {
    const store = createArtifactByteStore(key => ({ format: 'png', authority: key === 'old'
      ? certificate('room:one', '1') : key === 'new' ? certificate('room:one', '3') : certificate('room:two', '1') }));
    for (const key of ['old', 'new', 'unrelated']) await store.set(key, new Uint8Array([1]));
    expect(await store.revoke('room:one', '2')).toEqual(['old']);
    expect(await store.localUri('old')).toBeNull(); expect(await store.localUri('new')).not.toBeNull();
    expect(await store.localUri('unrelated')).not.toBeNull();
    await store.clear(); expect([...mocks.files.keys()]).toEqual([]);
    expect(mocks.deleted.mock.calls.every(([uri]) => uri.startsWith(directory))).toBe(true);
  });
  it('an invalid index cannot restore caller-controlled paths or touch files outside its owned cache', async () => {
    mocks.files.set(`${directory}index.json`, { text: 'invalid', size: 7 });
    mocks.files.set('file:///synthetic-cache/unrelated', { text: 'keep', size: 4 });
    expect(await createArtifactByteStore().get('key')).toBeNull();
    expect(mocks.files.has('file:///synthetic-cache/unrelated')).toBe(true);
    expect(mocks.deleted.mock.calls.every(([uri]) => uri.startsWith(directory))).toBe(true);
  });
});
