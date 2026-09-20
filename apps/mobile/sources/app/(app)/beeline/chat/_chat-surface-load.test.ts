import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  attachChatSurfaceAfterPaint,
  preloadChatSurface,
  resetChatSurfacePreloadForTests,
  type ChatSurfaceImporter,
} from './_chat-surface-load';
import { dispatchRoomOpenTap, roomOpenPixelSeed } from '@/buzz/room-open-prefetch';

type ChatSurfaceModule = typeof import('./_chat-surface');

const fakeSurface = { BuzzChatSurface: () => null } as unknown as ChatSurfaceModule;

function occupy(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // Busy-wait: this is the JS-thread steal a pending `import()` eval causes.
  }
}

afterEach(() => {
  resetChatSurfacePreloadForTests();
});

describe('chat surface preload', () => {
  it('reuses one in-flight pending import instead of starting a second evaluation', async () => {
    let resolveImport: ((mod: ChatSurfaceModule) => void) | undefined;
    const importer = vi.fn(
      () =>
        new Promise<ChatSurfaceModule>((resolve) => {
          resolveImport = resolve;
        }),
    );
    resetChatSurfacePreloadForTests(importer);
    const first = preloadChatSurface();
    const second = preloadChatSurface();
    expect(importer).toHaveBeenCalledOnce();
    expect(second).toBe(first);
    resolveImport!(fakeSurface);
    await expect(first).resolves.toBe(fakeSurface);
    await expect(second).resolves.toBe(fakeSurface);
  });

  it('reuses a resolved import without calling the importer again', async () => {
    const importer = vi.fn(async () => fakeSurface);
    resetChatSurfacePreloadForTests(importer);
    await expect(preloadChatSurface()).resolves.toBe(fakeSurface);
    await expect(preloadChatSurface()).resolves.toBe(fakeSurface);
    expect(importer).toHaveBeenCalledOnce();
  });

  it('clears a rejected import so a later open recovers', async () => {
    const importer = vi
      .fn<ChatSurfaceImporter>()
      .mockRejectedValueOnce(new Error('chunk missing'))
      .mockResolvedValueOnce(fakeSurface);
    resetChatSurfacePreloadForTests(importer);
    await expect(preloadChatSurface()).rejects.toThrow('chunk missing');
    await expect(preloadChatSurface()).resolves.toBe(fakeSurface);
    expect(importer).toHaveBeenCalledTimes(2);
  });

  it('does not evaluate chrome on the deck tap path even when import occupies the JS thread', () => {
    const importer = vi.fn(() => {
      occupy(60);
      return Promise.resolve(fakeSurface);
    });
    resetChatSurfacePreloadForTests(importer);
    const started = Date.now();
    const navigated: string[] = [];
    dispatchRoomOpenTap('room-a', 'PIXEL-450 NEWEST ROW', {
      navigate: (roomId) => navigated.push(roomId),
    });
    expect(Date.now() - started).toBeLessThan(40);
    expect(importer).not.toHaveBeenCalled();
    expect(navigated).toEqual(['room-a']);
    expect(roomOpenPixelSeed('room-a')).toBe('PIXEL-450 NEWEST ROW');
  });

  it('detects the steal: starting a pending occupying import before nav delays dispatch', () => {
    const importer = vi.fn(() => {
      occupy(60);
      return Promise.resolve(fakeSurface);
    });
    resetChatSurfacePreloadForTests(importer);
    const started = Date.now();
    void preloadChatSurface();
    const navigated: string[] = [];
    dispatchRoomOpenTap('room-a', undefined, {
      navigate: (roomId) => navigated.push(roomId),
    });
    expect(Date.now() - started).toBeGreaterThanOrEqual(60);
    expect(navigated).toEqual(['room-a']);
    expect(importer).toHaveBeenCalledOnce();
  });

  it('holds a pending idle import until paint settles, then delivers chrome', async () => {
    const importer = vi.fn(async () => fakeSurface);
    resetChatSurfacePreloadForTests(importer);
    let queued: (() => void) | null = null;
    const onReady = vi.fn();
    const cancel = attachChatSurfaceAfterPaint(onReady, (run) => {
      queued = run;
      return () => {
        queued = null;
      };
    });
    expect(importer).not.toHaveBeenCalled();
    expect(onReady).not.toHaveBeenCalled();
    queued!();
    await vi.waitFor(() => expect(onReady).toHaveBeenCalledWith(fakeSurface));
    expect(importer).toHaveBeenCalledOnce();
    cancel();
  });

  it('does not hang the thin shell when the idle import rejects, and retries once', async () => {
    const importer = vi
      .fn<ChatSurfaceImporter>()
      .mockRejectedValueOnce(new Error('chunk missing'))
      .mockResolvedValueOnce(fakeSurface);
    resetChatSurfacePreloadForTests(importer);
    const onReady = vi.fn();
    let queued: (() => void) | null = null;
    attachChatSurfaceAfterPaint(onReady, (run) => {
      queued = run;
      return () => undefined;
    });
    queued!();
    await vi.waitFor(() => expect(onReady).toHaveBeenCalledWith(fakeSurface));
    expect(importer).toHaveBeenCalledTimes(2);
  });

  it('cancels an unfired idle import so a later idle callback cannot attach', async () => {
    const importer = vi.fn(async () => fakeSurface);
    resetChatSurfacePreloadForTests(importer);
    let queued: (() => void) | undefined;
    const onReady = vi.fn();
    const cancel = attachChatSurfaceAfterPaint(onReady, (run) => {
      queued = run;
      return () => undefined;
    });
    cancel();
    queued!();
    await Promise.resolve();
    expect(importer).not.toHaveBeenCalled();
    expect(onReady).not.toHaveBeenCalled();
  });
});
