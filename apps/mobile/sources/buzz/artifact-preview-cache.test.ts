import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  captureRef: vi.fn(),
  getInfoAsync: vi.fn(),
  moveAsync: vi.fn(),
}));

vi.mock('react-native-view-shot', () => ({ captureRef: mocks.captureRef }));
vi.mock('expo-file-system/legacy', () => ({
  cacheDirectory: 'file:///cache/',
  getInfoAsync: mocks.getInfoAsync,
  moveAsync: mocks.moveAsync,
}));

import {
  artifactPreviewCachePath,
  probeArtifactPreview,
  resetArtifactPreviewCache,
  snapshotArtifactPreview,
} from './artifact-preview-cache';

const URL = '/v1/media/9f0f6a50-1111-4222-8333-444455556666';
const PATH = 'file:///cache/artifact-preview-9f0f6a50-1111-4222-8333-444455556666.png';

function never(): { current: number | null } {
  return { current: 1 };
}

beforeEach(() => {
  resetArtifactPreviewCache();
  mocks.captureRef.mockReset();
  mocks.getInfoAsync.mockReset();
  mocks.moveAsync.mockReset();
});

describe('the device preview cache keyed by object id', () => {
  it('derives the cache path from the object id', () => {
    expect(artifactPreviewCachePath('9f0f6a50-1111-4222-8333-444455556666')).toBe(PATH);
  });

  it('captures once and moves the snapshot into the cache', async () => {
    mocks.getInfoAsync.mockResolvedValue({ exists: false });
    mocks.captureRef.mockResolvedValue('file:///cache/tmp-shot.png');
    mocks.moveAsync.mockResolvedValue(undefined);

    await expect(snapshotArtifactPreview(URL, never())).resolves.toBe(PATH);
    expect(mocks.captureRef).toHaveBeenCalledTimes(1);
    expect(mocks.moveAsync).toHaveBeenCalledWith({ from: 'file:///cache/tmp-shot.png', to: PATH });
  });

  it('serves every later mount from the cache — no second render on scroll', async () => {
    mocks.getInfoAsync
      .mockResolvedValueOnce({ exists: false })
      .mockResolvedValue({ exists: true });
    mocks.captureRef.mockResolvedValue('file:///cache/tmp-shot.png');

    await snapshotArtifactPreview(URL, never());
    await expect(snapshotArtifactPreview(URL, never())).resolves.toBe(PATH);
    await expect(probeArtifactPreview(URL)).resolves.toBe(PATH);
    expect(mocks.captureRef).toHaveBeenCalledTimes(1);
  });

  it('never doubles the capture while one is in flight', async () => {
    mocks.getInfoAsync.mockResolvedValue({ exists: false });
    let release!: () => void;
    mocks.captureRef.mockReturnValue(
      new Promise<string>((resolve) => {
        release = () => resolve('file:///cache/tmp-shot.png');
      }),
    );
    mocks.moveAsync.mockResolvedValue(undefined);

    const first = snapshotArtifactPreview(URL, never());
    // The second concurrent mount (the same card re-rendering) declines.
    const second = snapshotArtifactPreview(URL, never());
    await expect(second).resolves.toBeNull();
    release();
    await expect(first).resolves.toBe(PATH);
    expect(mocks.captureRef).toHaveBeenCalledTimes(1);
  });

  it('names no snapshot for a URL without a media id, and a failed capture stays null', async () => {
    await expect(probeArtifactPreview('https://example.com/other')).resolves.toBeNull();
    mocks.getInfoAsync.mockResolvedValue({ exists: false });
    mocks.captureRef.mockRejectedValue(new Error('capture failed'));
    await expect(snapshotArtifactPreview(URL, never())).resolves.toBeNull();
  });
});
