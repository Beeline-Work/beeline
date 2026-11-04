import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  files: new Map<string, { text: string; size: number; bytes?: Uint8Array }>(), peak: 0,
  reads: vi.fn(), writes: vi.fn(), deleted: vi.fn(), nativeWrites: vi.fn(), nativeReads: vi.fn(),
  typed: true, partial: false, failWrite: false, afterWrite: undefined as (() => void) | undefined,
  autoFrames: true, frames: new Map<number, FrameRequestCallback>(), frameId: 0,
  onFrame: undefined as (() => void) | undefined, closed: vi.fn(),
}));
const directory = 'file:///synthetic-cache/beeline-immutable-bytes-v1/';
vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
vi.mock('expo-file-system/legacy', () => ({
  cacheDirectory: 'file:///synthetic-cache/', EncodingType: { Base64: 'base64', UTF8: 'utf8' },
  makeDirectoryAsync: async () => {},
  getInfoAsync: async (uri: string) => mocks.files.has(uri) ? { exists: true, isDirectory: false, size: mocks.files.get(uri)!.size } : { exists: false },
  readDirectoryAsync: async (uri: string) => [...mocks.files.keys()].filter(key => key.startsWith(uri)).map(key => key.slice(uri.length)),
  readAsStringAsync: async (uri: string, options: { encoding: string }) => { mocks.reads(uri); const value = mocks.files.get(uri); if (!value) throw new Error('missing'); return value.bytes && options.encoding === 'base64' ? Buffer.from(value.bytes).toString('base64') : value.text; },
  writeAsStringAsync: async (uri: string, text: string, options: { encoding: string }) => {
    mocks.writes(uri, options.encoding);
    const size = options.encoding === 'base64' ? text.length / 4 * 3 - (text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0) : new TextEncoder().encode(text).length;
    mocks.files.set(uri, { text: size > 1024 * 1024 ? '' : text, size });
    mocks.peak = Math.max(mocks.peak, [...mocks.files.values()].reduce((total, file) => total + file.size, 0));
  },
  moveAsync: async ({ from, to }: { from: string; to: string }) => { const value = mocks.files.get(from); if (!value) throw new Error('missing'); mocks.files.delete(from); mocks.files.set(to, value); },
  deleteAsync: async (uri: string) => { mocks.deleted(uri); for (const key of mocks.files.keys()) if (key === uri || uri.endsWith('/') && key.startsWith(uri)) mocks.files.delete(key); },
}));
vi.mock('expo-file-system', () => ({
  File: class {
    constructor(private readonly uri: string) {}
    create() { mocks.files.set(this.uri, { text: '', size: 0, bytes: new Uint8Array() }); }
    get open() { return mocks.typed ? () => {
      let offset = 0;
      return {
        writeBytes: (bytes: Uint8Array) => {
          mocks.nativeWrites(this.uri, bytes.byteLength);
          const previous = mocks.files.get(this.uri)!;
          const size = offset + bytes.byteLength - (mocks.partial ? 1 : 0);
          const content = size <= 1024 * 1024 ? new Uint8Array(size) : undefined;
          if (content) { content.set(previous.bytes ?? [], 0); content.set(bytes.subarray(0, size - offset), offset); }
          mocks.files.set(this.uri, { text: '', size, bytes: content }); offset += bytes.byteLength;
          mocks.peak = Math.max(mocks.peak, [...mocks.files.values()].reduce((total, file) => total + file.size, 0));
          mocks.afterWrite?.();
          if (mocks.failWrite) throw new Error('native write failed');
        },
        readBytes: (length: number) => {
          mocks.nativeReads(this.uri, length);
          const file = mocks.files.get(this.uri); if (!file) throw new Error('missing');
          const source = file.bytes ?? (file.text ? new Uint8Array(Buffer.from(file.text, 'base64')) : undefined);
          const size = Math.max(0, Math.min(length, file.size - offset));
          const bytes = source ? source.slice(offset, offset + size) : new Uint8Array(size);
          offset += size; return bytes;
        },
        close: () => mocks.closed(this.uri),
      };
    } : undefined; }
  },
}));
import { createArtifactByteStore } from './artifact-byte-store';
const certificate = (scope: string, epoch: string) => ({ digest: 'a'.repeat(64), scopes: [{ authorityScope: scope, epoch }] });
beforeEach(() => {
  mocks.files.clear(); mocks.peak = 0; mocks.typed = true; mocks.partial = false; mocks.failWrite = false; mocks.afterWrite = undefined;
  mocks.autoFrames = true; mocks.frames.clear(); mocks.frameId = 0; mocks.onFrame = undefined;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = ++mocks.frameId; mocks.frames.set(id, callback);
    if (mocks.autoFrames) queueMicrotask(() => { if (mocks.frames.delete(id)) callback(performance.now()); });
    mocks.onFrame?.(); return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { mocks.frames.delete(id); });
  for (const spy of [mocks.reads, mocks.writes, mocks.deleted, mocks.nativeReads, mocks.nativeWrites, mocks.closed]) spy.mockClear();
});
afterEach(() => { vi.unstubAllGlobals(); });
describe('owned immutable native byte disk', () => {
  it('uses raw native bytes without a JS base64 encode/decode on capable binaries', async () => {
    const store = createArtifactByteStore(); await store.set('key', new Uint8Array([1, 2, 3]));
    const uri = (await store.localUri('key'))!;
    expect(await store.get('key')).toEqual(new Uint8Array([1, 2, 3]));
    expect(mocks.nativeWrites).toHaveBeenCalledWith(`${uri}.next`, 3);
    expect(mocks.nativeReads).toHaveBeenCalledWith(uri, 3);
    expect(mocks.writes.mock.calls.some(([, encoding]) => encoding === 'base64')).toBe(false);
    expect(mocks.reads).not.toHaveBeenCalledWith(uri);
  });
  it('keeps old local files readable in either native capability cohort without another transport', async () => {
    mocks.typed = false;
    const legacy = createArtifactByteStore(); await legacy.set('old', new Uint8Array([7, 8]));
    expect(await legacy.get('old')).toEqual(new Uint8Array([7, 8]));
    mocks.typed = true;
    const current = createArtifactByteStore(); expect(await current.get('old')).toEqual(new Uint8Array([7, 8]));
    await current.set('new', new Uint8Array([9, 10]));
    mocks.typed = false;
    expect(await createArtifactByteStore().get('new')).toEqual(new Uint8Array([9, 10]));
  });
  it.each(['short write', 'native failure'])('never publishes or retains a temporary file after %s', async reason => {
    mocks.partial = reason === 'short write'; mocks.failWrite = reason === 'native failure';
    const store = createArtifactByteStore();
    await expect(store.set('key', new Uint8Array([1, 2, 3]))).rejects.toThrow();
    expect([...mocks.files.keys()].some(uri => uri.endsWith('.next'))).toBe(false);
    expect(await store.localUri('key')).toBeNull();
  });
  it('cancellation before work preserves the old entry; cancellation during staging never promotes it', async () => {
    const store = createArtifactByteStore(); await store.set('old', new Uint8Array([1]));
    const stopped = new AbortController(); stopped.abort();
    await expect(store.set('old', new Uint8Array([2]), stopped.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(await store.get('old')).toEqual(new Uint8Array([1]));
    const active = new AbortController(); mocks.afterWrite = () => active.abort();
    await expect(store.set('new', new Uint8Array([3]), active.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(await store.localUri('new')).toBeNull();
    expect([...mocks.files.keys()].some(uri => uri.endsWith('.next'))).toBe(false);
  });
  it('bounds native calls, preserves offset views and yields between finite transfer batches', async () => {
    const store = createArtifactByteStore(); const source = new Uint8Array(2 * 1024 * 1024 + 2);
    source[1] = 17; source[source.length - 2] = 23;
    await store.set('large', source.subarray(1, source.length - 1));
    expect(mocks.frameId).toBeGreaterThan(0);
    expect(Math.max(...mocks.nativeWrites.mock.calls.map(([, length]) => length))).toBeLessThanOrEqual(64 * 1024);
    // The virtual large file tracks size rather than duplicating its contents.
    const bytes = await store.get('large'); expect(bytes?.length).toBe(source.length - 2);
    expect(Math.max(...mocks.nativeReads.mock.calls.map(([, length]) => length))).toBeLessThanOrEqual(64 * 1024);
    await store.set('offset', new Uint8Array([99, 17, 23, 99]).subarray(1, 3));
    expect(await store.get('offset')).toEqual(new Uint8Array([17, 23]));
  });
  it('aborts a suspended frame immediately and closes/removes the staged file without a frame or timer', async () => {
    mocks.autoFrames = false;
    const store = createArtifactByteStore(); const controller = new AbortController();
    const queued = new Promise<void>(resolve => { mocks.onFrame = resolve; });
    const result = store.set('hidden', new Uint8Array(2 * 1024 * 1024), controller.signal);
    const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    await queued; expect(mocks.frames.size).toBe(1); controller.abort(); await rejected;
    expect(mocks.frames.size).toBe(0); expect(mocks.closed).toHaveBeenCalled();
    expect([...mocks.files.keys()].some(uri => uri.endsWith('.next'))).toBe(false);
    expect(await store.localUri('hidden')).toBeNull();
  });
  it('aborts a suspended cold read without deleting healthy bytes or falling back to another read', async () => {
    const store = createArtifactByteStore(); await store.set('held', new Uint8Array(2 * 1024 * 1024));
    const uri = (await store.localUri('held'))!; mocks.autoFrames = false;
    const controller = new AbortController();
    const queued = new Promise<void>(resolve => { mocks.onFrame = resolve; });
    const result = store.get('held', controller.signal);
    const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    await queued; controller.abort(); await rejected;
    expect(mocks.frames.size).toBe(0); expect(await store.localUri('held')).toBe(uri);
    expect(mocks.reads).not.toHaveBeenCalledWith(uri);
  });
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
  it('rejects an oversized index from stat before decoding any of its bytes', async () => {
    const uri = `${directory}index.json`;
    mocks.files.set(uri, { text: '[]', size: 1024 * 1024 + 1 });
    expect(await createArtifactByteStore().get('key')).toBeNull();
    expect(mocks.reads).not.toHaveBeenCalledWith(uri);
    expect(mocks.deleted).toHaveBeenCalledWith(directory);
  });
  // The native adapter receives real 25MiB views; the virtual filesystem
  // records resident and atomic temporary sizes independently of the codec.
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
