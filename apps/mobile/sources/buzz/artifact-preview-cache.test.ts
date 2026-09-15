import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  captureRef: vi.fn(),
  getInfoAsync: vi.fn(),
  moveAsync: vi.fn(),
  deleteAsync: vi.fn(),
  readAsStringAsync: vi.fn(),
}));

vi.mock('react-native-view-shot', () => ({ captureRef: mocks.captureRef }));
vi.mock('expo-file-system/legacy', () => ({
  cacheDirectory: 'file:///cache/',
  getInfoAsync: mocks.getInfoAsync,
  moveAsync: mocks.moveAsync,
  deleteAsync: mocks.deleteAsync,
  readAsStringAsync: mocks.readAsStringAsync,
  EncodingType: { Base64: 'base64' },
}));

import {
  artifactPreviewCachePath,
  probeArtifactPreview,
  resetArtifactPreviewCache,
  setArtifactCaptureSettleForTests,
  snapshotArtifactPreview,
} from './artifact-preview-cache';

const URL = '/v1/media/9f0f6a50-1111-4222-8333-444455556666';
const PATH = 'file:///cache/artifact-preview-9f0f6a50-1111-4222-8333-444455556666-v2.png';
const LEGACY_PATH = 'file:///cache/artifact-preview-9f0f6a50-1111-4222-8333-444455556666.png';

function never(): { current: number | null } {
  return { current: 1 };
}

beforeEach(() => {
  resetArtifactPreviewCache();
  setArtifactCaptureSettleForTests(0);
  mocks.captureRef.mockReset();
  mocks.getInfoAsync.mockReset();
  mocks.moveAsync.mockReset();
  mocks.deleteAsync.mockReset();
  mocks.readAsStringAsync.mockReset();
  mocks.deleteAsync.mockResolvedValue(undefined);
  mocks.moveAsync.mockResolvedValue(undefined);
});

afterEach(() => {
  setArtifactCaptureSettleForTests(400);
});

describe('the device preview cache keyed by object id', () => {
  it('derives the cache path from the object id', () => {
    expect(artifactPreviewCachePath('9f0f6a50-1111-4222-8333-444455556666')).toBe(PATH);
  });

  it('captures a settled page — two agreeing captures — and moves it into the cache', async () => {
    mocks.getInfoAsync.mockResolvedValue({ exists: false });
    mocks.captureRef
      .mockResolvedValueOnce('file:///cache/tmp-shot-1.png')
      .mockResolvedValue('file:///cache/tmp-shot-2.png');
    // Both captures agree: the page had already painted before round one.
    mocks.readAsStringAsync.mockResolvedValue('aGVsbG8=');

    await expect(snapshotArtifactPreview(URL, never())).resolves.toBe(PATH);
    expect(mocks.captureRef).toHaveBeenCalledTimes(2);
    expect(mocks.moveAsync).toHaveBeenCalledWith({ from: 'file:///cache/tmp-shot-2.png', to: PATH });
  });

  it('does not persist a capture that raced the first paint — the settled one wins', async () => {
    mocks.getInfoAsync.mockResolvedValue({ exists: false });
    mocks.captureRef
      .mockResolvedValueOnce('file:///cache/tmp-shot-blank.png')
      .mockResolvedValueOnce('file:///cache/tmp-shot-painted.png')
      .mockResolvedValueOnce('file:///cache/tmp-shot-painted-2.png');
    // Round one is the unpainted blank; rounds two and three agree.
    mocks.readAsStringAsync.mockImplementation(async (path: string) =>
      path === 'file:///cache/tmp-shot-blank.png' ? 'Ymxhbms=' : 'cGFpbnRlZA==',
    );

    await expect(snapshotArtifactPreview(URL, never())).resolves.toBe(PATH);
    expect(mocks.captureRef).toHaveBeenCalledTimes(3);
    // The blank tmpfile is never the one moved into the cache.
    expect(mocks.moveAsync).toHaveBeenCalledWith({ from: 'file:///cache/tmp-shot-painted-2.png', to: PATH });
    expect(mocks.moveAsync).not.toHaveBeenCalledWith(
      expect.objectContaining({ from: 'file:///cache/tmp-shot-blank.png' }),
    );
  });

  it('caches its last capture when a page never settles, so the card is not blank forever', async () => {
    mocks.getInfoAsync.mockResolvedValue({ exists: false });
    mocks.captureRef.mockImplementation(async () => `file:///cache/tmp-shot-${Math.random()}.png`);
    // Every capture is distinct (the page keeps changing): no two agree.
    mocks.readAsStringAsync.mockImplementation(async (path: string) => path);

    await expect(snapshotArtifactPreview(URL, never())).resolves.toBe(PATH);
    expect(mocks.captureRef).toHaveBeenCalledTimes(4);
    expect(mocks.moveAsync).toHaveBeenCalledTimes(1);
  });

  it('serves every later mount from the cache — no second render on scroll', async () => {
    mocks.getInfoAsync
      .mockResolvedValueOnce({ exists: false })
      .mockResolvedValue({ exists: true });
    mocks.captureRef.mockResolvedValue('file:///cache/tmp-shot.png');
    mocks.readAsStringAsync.mockResolvedValue('aGVsbG8=');

    await snapshotArtifactPreview(URL, never());
    await expect(snapshotArtifactPreview(URL, never())).resolves.toBe(PATH);
    await expect(probeArtifactPreview(URL)).resolves.toBe(PATH);
    expect(mocks.captureRef).toHaveBeenCalledTimes(2);
  });

  it('heals a pre-fix install: a legacy cache file is deleted and re-captured, not trusted', async () => {
    // First lookup: neither v2 nor legacy exists; capture lands.
    mocks.getInfoAsync.mockResolvedValue({ exists: false });
    mocks.captureRef.mockResolvedValue('file:///cache/tmp-shot.png');
    mocks.readAsStringAsync.mockResolvedValue('aGVsbG8=');
    await snapshotArtifactPreview(URL, never());

    // Second lookup: v2 missing (cache cleared by the OS), legacy present.
    mocks.captureRef.mockClear();
    mocks.moveAsync.mockClear();
    mocks.getInfoAsync
      .mockResolvedValueOnce({ exists: false }) // v2 probe
      .mockResolvedValueOnce({ exists: true }) // legacy probe → deleted
      .mockResolvedValue({ exists: false });
    mocks.captureRef
      .mockResolvedValueOnce('file:///cache/tmp-shot-1.png')
      .mockResolvedValue('file:///cache/tmp-shot-2.png');
    mocks.readAsStringAsync.mockResolvedValue('aGVsbG8=');

    await expect(probeArtifactPreview(URL)).resolves.toBeNull();
    expect(mocks.deleteAsync).toHaveBeenCalledWith(LEGACY_PATH);
    await expect(snapshotArtifactPreview(URL, never())).resolves.toBe(PATH);
    expect(mocks.captureRef).toHaveBeenCalledTimes(2);
  });

  it('never doubles the capture while one is in flight', async () => {
    mocks.getInfoAsync.mockResolvedValue({ exists: false });
    let release!: () => void;
    mocks.captureRef.mockReturnValue(
      new Promise<string>((resolve) => {
        release = () => resolve('file:///cache/tmp-shot.png');
      }),
    );
    mocks.readAsStringAsync.mockResolvedValue('aGVsbG8=');

    const first = snapshotArtifactPreview(URL, never());
    // The second concurrent mount (the same card re-rendering) declines.
    const second = snapshotArtifactPreview(URL, never());
    await expect(second).resolves.toBeNull();
    release();
    await expect(first).resolves.toBe(PATH);
  });

  it('names no snapshot for a URL without a media id, and a failed capture stays null', async () => {
    await expect(probeArtifactPreview('https://example.com/other')).resolves.toBeNull();
    mocks.getInfoAsync.mockResolvedValue({ exists: false });
    mocks.captureRef.mockRejectedValue(new Error('capture failed'));
    await expect(snapshotArtifactPreview(URL, never())).resolves.toBeNull();
  });

  it('skips capture when the view is already gone', async () => {
    mocks.getInfoAsync.mockResolvedValue({ exists: false });
    await expect(snapshotArtifactPreview(URL, { current: null })).resolves.toBeNull();
    expect(mocks.captureRef).not.toHaveBeenCalled();
  });
});
