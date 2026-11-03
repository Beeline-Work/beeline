import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type * as Livekit from 'livekit-client';

const require = createRequire(import.meta.url);
const { patchLivekitOwned } = require('../../scripts/patch-livekit-owned.cjs') as { patchLivekitOwned(root: string): void };
const files = ['package.json', 'src/room/Room.ts', 'src/room/RTCEngine.ts',
  'dist/livekit-client.esm.mjs', 'dist/livekit-client.umd.js', 'dist/livekit-client.esm.mjs.map'];
let fixture: string;
let esm: typeof Livekit, commonjs: typeof Livekit;
beforeAll(async () => {
  const parent = resolve('.beeline-proof'); mkdirSync(parent, { recursive: true });
  fixture = mkdtempSync(resolve(parent, 'livekit-owned-'));
  for (const file of files) {
    const destination = resolve(fixture, file); mkdirSync(dirname(destination), { recursive: true });
    // Copy bytes: installed dependencies may be hardlinked across worktrees.
    copyFileSync(resolve('node_modules/livekit-client', file), destination);
  }
  patchLivekitOwned(fixture);
  const once = files.map(file => readFileSync(resolve(fixture, file), 'utf8'));
  patchLivekitOwned(fixture);
  expect(files.map(file => readFileSync(resolve(fixture, file), 'utf8'))).toEqual(once);
  esm = await import(/* @vite-ignore */ pathToFileURL(resolve(fixture, files[3]!)).href);
  commonjs = require(resolve(fixture, files[4]!));
});
beforeEach(() => {
  vi.stubGlobal('RTCPeerConnection', class { addTransceiver() {} });
  vi.stubGlobal('CompressionStream', undefined);
  vi.stubGlobal('DecompressionStream', undefined);
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
afterAll(() => { if (fixture) rmSync(fixture, { recursive: true, force: true }); });

describe.each(['ESM', 'CommonJS'])('%s owned SDK admission', format => {
  it.each([false, true])('does not probe or fail over cloud regions (retained provider: %s)', async retained => {
    vi.useFakeTimers();
    const sdk = format === 'ESM' ? esm : commonjs;
    const fetch = vi.fn().mockRejectedValue(new Error('unexpected region request'));
    vi.stubGlobal('fetch', fetch);
    const room = new sdk.Room({ reconnectPolicy: { nextRetryDelayInMs: () => null } });
    const failure = sdk.ConnectionError.serverUnreachable('fixture refusal', 503);
    const internal = room as unknown as { attemptConnection: () => Promise<void>; handleDisconnect: () => void; regionUrlProvider?: unknown };
    const nextRegion = vi.fn().mockResolvedValue('wss://other.livekit.cloud');
    if (retained) internal.regionUrlProvider = {
      getServerUrl: () => new URL('wss://owned-proof.livekit.cloud/'),
      getNextBestRegionUrl: nextRegion, notifyDisconnected: () => {},
    };
    internal.attemptConnection = vi.fn().mockRejectedValue(failure);
    internal.handleDisconnect = vi.fn();
    await expect(room.connect('wss://owned-proof.livekit.cloud', 'fixture-token', { maxRetries: 0 })).rejects.toBe(failure);
    expect(internal.attemptConnection).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
    expect(nextRegion).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(86_400_000);
    expect(internal.attemptConnection).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
    expect(nextRegion).not.toHaveBeenCalled();
    await room.disconnect();
  });
  it.each(['serviceNotFound', 'serverUnreachable'] as const)('returns %s without a second signal join', async reason => {
    vi.useFakeTimers();
    const sdk = format === 'ESM' ? esm : commonjs;
    const room = new sdk.Room();
    const engine = (room as unknown as { engine: {
      client: { join: () => Promise<unknown> }; join: (...args: unknown[]) => Promise<unknown>;
    } }).engine;
    const failure = sdk.ConnectionError[reason]('fixture refusal');
    const second = new Error('unexpected second signal join');
    engine.client.join = vi.fn().mockRejectedValueOnce(failure).mockRejectedValue(second);
    await expect(engine.join('ws://localhost:7880', 'fixture-token', {
      autoSubscribe: true, maxRetries: 0, e2eeEnabled: false,
      websocketTimeout: 1000, singlePeerConnection: false,
    })).rejects.toBe(failure);
    expect(engine.client.join).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(86_400_000);
    expect(engine.client.join).toHaveBeenCalledOnce();
    await room.disconnect();
  });
});
