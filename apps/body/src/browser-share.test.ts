import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import { waitForComputerHandback } from './browser-share.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  vi.restoreAllMocks();
});

async function waitServer(frames: string[]) {
  const server = createServer();
  const sockets = new WebSocketServer({ server });
  sockets.on('connection', (socket) => {
    for (const frame of frames) socket.send(frame);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(async () => {
    for (const socket of sockets.clients) socket.terminate();
    await new Promise<void>((resolve) => sockets.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('computer handback protocol compatibility', () => {
  it('keeps waiting through newer message types and activity names until handback', async () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const activity = { type: 'event', seq: 2, at: '2026-10-11T20:00:00Z', name: 'viewer-opened' };
    const origin = await waitServer([
      JSON.stringify({ type: 'future-activity', name: 'viewer-opened' }),
      JSON.stringify({ type: 'future-activity' }),
      JSON.stringify({ ...activity, seq: 1, name: 'future-gesture' }),
      JSON.stringify(activity),
      JSON.stringify({ type: 'handoff', note: 'Finished' }),
    ]);
    const onEvent = vi.fn();
    await expect(waitForComputerHandback({ serverBaseUrl: origin, shareId: 'test', daemonToken: 'token', onEvent }))
      .resolves.toEqual({ type: 'handoff', note: 'Finished', events: [activity] });
    expect(onEvent.mock.calls).toEqual([[activity]]);
    expect(debug).toHaveBeenCalledTimes(2);
  });

  it.each(['not json', 'null', '{}', '{"type":123}', '{"type":""}'])('still rejects malformed handback frames: %s', async (frame) => {
    const origin = await waitServer([frame]);
    await expect(waitForComputerHandback({ serverBaseUrl: origin, shareId: 'test', daemonToken: 'token' }))
      .rejects.toThrow();
  });

  it('preserves the existing handling of malformed known activity messages', async () => {
    const origin = await waitServer([
      JSON.stringify({ type: 'event', seq: 'bad', name: 'viewer-opened' }),
      JSON.stringify({ type: 'ended' }),
    ]);
    await expect(waitForComputerHandback({ serverBaseUrl: origin, shareId: 'test', daemonToken: 'token' }))
      .resolves.toEqual({ type: 'ended', events: [] });
  });
});
