import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, it, vi } from 'vitest';
import { createBeelineServer, type ServerOptions } from './server.js';
import { LiveHub } from './live.js';
const servers: ReturnType<typeof createBeelineServer>[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(servers.splice(0).map(s => new Promise<void>(r => s.close(() => r())))); });
async function start() {
  const identity = randomUUID();
  const server = createBeelineServer({ database: {}, auth: { authenticatePhone: async () => identity },
    phone: {}, daemon: {}, live: new LiveHub(), mediaMaximumBytes: 1 } as unknown as ServerOptions);
  servers.push(server); await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return (body: unknown, authenticated = true) => fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/phone/observations/client-error`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(authenticated ? { authorization: 'Bearer isolated-diagnostic-fixture-token' } : {}) }, body: JSON.stringify(body),
  });
}
const observation = { scope: 'conversation', message: 'Voice render failed', stack: 'at VoiceBar:42', platform: 'android', platformVersion: '36', releaseSha: 'abc', runtimeVersion: '34', updateId: 'update' };
it('logs an authenticated error without credentials and refuses anonymous reports', async () => {
  const post = await start(); const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
  expect((await post(observation, false)).status).toBe(401);
  expect(log).not.toHaveBeenCalled();
  expect((await post({ ...observation, message: 'Failed https://example.test/?secret=x Bearer secret' })).status).toBe(204);
  expect(log.mock.calls[0]?.[0]).toBe('[client-error]');
  const recorded = String(log.mock.calls[0]?.[1]);
  expect(recorded).toContain('VoiceBar'); expect(recorded).not.toContain('?secret=x'); expect(recorded).not.toContain('Bearer secret');
});
it('rejects oversized and malformed diagnostics', async () => {
  const post = await start();
  expect((await post({ ...observation, message: 'x'.repeat(2049) })).status).toBe(400);
  expect((await post({ ...observation, scope: 'arbitrary' })).status).toBe(400);
});

it('limits diagnostic writes per authenticated identity', async () => {
  const post = await start(); const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
  for (let index = 0; index < 12; index++) expect((await post(observation)).status).toBe(204);
  expect((await post(observation)).status).toBe(429);
  expect(log).toHaveBeenCalledTimes(12);
});
