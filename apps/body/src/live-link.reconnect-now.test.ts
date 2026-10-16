import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { LiveLink, LIVE_LINK_TIMING } from './live-link.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function server() {
  const http = createServer();
  const wss = new WebSocketServer({ server: http });
  const opened: number[] = [];
  wss.on('connection', () => opened.push(Date.now()));
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  cleanups.push(async () => {
    for (const client of wss.clients) client.terminate();
    wss.close();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  });
  return { url: `ws://127.0.0.1:${(http.address() as AddressInfo).port}`, opened };
}

async function until(check: () => boolean, ms = 2_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('LiveLink.reconnectNow', () => {
  it('replaces an open socket at once, skipping the reconnect backoff and jitter', async () => {
    const { url, opened } = await server();
    let opens = 0;
    const link = new LiveLink({
      url: () => url,
      protocols: () => [],
      factory: (target, protocols, options) => new WebSocket(target, protocols, options),
      onOpen: () => opens++,
      onMessage: () => undefined,
      onClose: () => undefined,
      onUpdateRequired: () => undefined,
      // An ordinary close of this young socket would wait almost 20 seconds.
      timing: { ...LIVE_LINK_TIMING, backoffBaseMs: 20_000 },
      random: () => 0.99,
    });
    cleanups.push(() => link.stop());
    link.start();
    await until(() => opens === 1);
    const asked = Date.now();
    link.reconnectNow();
    await until(() => opens === 2);
    expect(opened).toHaveLength(2);
    expect(opened[1]! - asked).toBeLessThan(1_000);
    expect(link.reconnects).toBe(1);
  });

  it('does nothing for a link nobody wants', async () => {
    const { url, opened } = await server();
    const link = new LiveLink({
      url: () => url,
      protocols: () => [],
      factory: (target, protocols, options) => new WebSocket(target, protocols, options),
      onOpen: () => undefined,
      onMessage: () => undefined,
      onClose: () => undefined,
      onUpdateRequired: () => undefined,
    });
    link.reconnectNow();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(opened).toEqual([]);
    expect(link.state).toBe('disconnected');
  });
});
