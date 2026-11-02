import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
const mocks = vi.hoisted(() => ({ native: vi.fn(), frames: new Map<number, FrameRequestCallback>(),
  frameId: 0, autoFrames: true, onFrame: undefined as (() => void) | undefined }));
vi.mock('expo-crypto', () => ({ digest: mocks.native, CryptoDigestAlgorithm: { SHA256: 'SHA-256' } }));
import { artifactByteDigest } from './artifact-byte-digest';
beforeEach(() => {
  mocks.native.mockReset().mockImplementation(async (_algorithm, bytes: Uint8Array) => sha256(bytes).buffer);
  mocks.frames.clear(); mocks.frameId = 0; mocks.autoFrames = true; mocks.onFrame = undefined;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = ++mocks.frameId; mocks.frames.set(id, callback);
    if (mocks.autoFrames) queueMicrotask(() => { if (mocks.frames.delete(id)) callback(performance.now()); });
    mocks.onFrame?.(); return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { mocks.frames.delete(id); });
});
afterEach(() => { vi.unstubAllGlobals(); });
describe('immutable byte integrity without a synchronous JS object hash', () => {
  it('passes the exact offset view to the existing native byte digest', async () => {
    const bytes = new Uint8Array([99, 17, 23, 99]).subarray(1, 3);
    expect(await artifactByteDigest(bytes)).toBe(bytesToHex(sha256(new Uint8Array([17, 23]))));
    expect(mocks.native).toHaveBeenCalledWith('SHA-256', bytes);
    expect(mocks.frameId).toBe(0);
  });
  it('retains exact local integrity and finite frame yields if the older native digest is unavailable', async () => {
    mocks.native.mockRejectedValue(new Error('older binary'));
    const bytes = new Uint8Array(2 * 1024 * 1024 + 1); bytes[0] = 17; bytes[bytes.length - 1] = 23;
    expect(await artifactByteDigest(bytes)).toBe(bytesToHex(sha256(bytes)));
    expect(mocks.frameId).toBeGreaterThan(0);
  });
  it('aborts a suspended fallback hash immediately without waiting for another frame', async () => {
    mocks.native.mockRejectedValue(new Error('older binary')); mocks.autoFrames = false;
    const controller = new AbortController();
    const queued = new Promise<void>(resolve => { mocks.onFrame = resolve; });
    const pending = artifactByteDigest(new Uint8Array(2 * 1024 * 1024), controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await queued; controller.abort(); await rejected; expect(mocks.frames.size).toBe(0);
  });
  it('rejects a malformed native result without accepting bytes or silently changing the algorithm', async () => {
    mocks.native.mockResolvedValue(new ArrayBuffer(31));
    await expect(artifactByteDigest(new Uint8Array([1]))).rejects.toThrow('Invalid local file digest');
    expect(mocks.frameId).toBe(0);
  });
  it('fences native completion after the last visible owner disappears', async () => {
    let finish!: (bytes: ArrayBuffer) => void;
    mocks.native.mockImplementation(() => new Promise<ArrayBuffer>(resolve => { finish = resolve; }));
    const entered = new Promise<void>(resolve => { mocks.native.mockImplementationOnce(() => {
      resolve(); return new Promise<ArrayBuffer>(done => { finish = done; });
    }); });
    const controller = new AbortController();
    const pending = artifactByteDigest(new Uint8Array([1]), controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await entered; controller.abort(); finish(new ArrayBuffer(32)); await rejected;
  });
  it('a pre-aborted demand performs no native or local hash work', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(artifactByteDigest(new Uint8Array([1]), controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(mocks.native).not.toHaveBeenCalled();
  });
  it('rejects an oversized object before native or local hashing', async () => {
    await expect(artifactByteDigest(new Uint8Array(25 * 1024 * 1024 + 1))).rejects.toThrow('25 MiB');
    expect(mocks.native).not.toHaveBeenCalled();
  });
});
