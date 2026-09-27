import { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TokenAuth } from './auth.js';
import type { DaemonService } from './daemon-service.js';
import type { PhoneService } from './phone-service.js';
import type { ReleaseNotifier } from './release-notify.js';
import { LiveHub } from './live.js';
import { createBeelineServer } from './server.js';
import { HelperVersionGate, helperVersionBelowMinimum } from './helper-version-gate.js';

describe('helper minimum version', () => {
  const servers: ReturnType<typeof createBeelineServer>[] = [];
  const sockets: WebSocket[] = [];
  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.terminate();
    await Promise.all(servers.splice(0).map((server) =>
      new Promise<void>((resolve) => server.close(() => resolve()))));
  });

  it('compares release versions numerically and fails closed for missing versions', () => {
    expect(helperVersionBelowMinimum('v0.0.9', 'v0.0.10')).toBe(true);
    expect(helperVersionBelowMinimum('v0.1.0', 'v0.0.10')).toBe(false);
    expect(helperVersionBelowMinimum(undefined, 'v0.0.10')).toBe(true);
    expect(helperVersionBelowMinimum('invalid', 'v0.0.10')).toBe(true);
    const gate = new HelperVersionGate('v0.0.10');
    expect(() => gate.raise('v0.0.9')).toThrow(/cannot decrease/);
  });

  it('refuses an old HTTP helper and socket before authentication or Room reads', async () => {
    const authenticateDaemon = vi.fn().mockResolvedValue('agent');
    const canReadRooms = vi.fn();
    const execute = vi.fn().mockResolvedValue({ commandProtocol: 1, commands: [] });
    const server = createBeelineServer({
      database: { query: vi.fn(), transaction: vi.fn() },
      auth: { authenticateDaemon, authenticatePhone: vi.fn().mockResolvedValue(null) } as unknown as TokenAuth,
      phone: { canReadRooms } as unknown as PhoneService,
      daemon: { execute } as unknown as DaemonService,
      live: new LiveHub(), mediaMaximumBytes: 1,
      helperVersionGate: new HelperVersionGate('v0.0.10'),
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const url = `http://127.0.0.1:${port}/v1/daemon/operations/getAgentCommands`;
    const post = (version?: string) => fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${'bdt_' + 't'.repeat(24)}`, 'content-type': 'application/json',
        ...(version ? { 'x-beeline-helper-version': version } : {}) },
      body: '{}',
    });
    const old = await post('v0.0.9');
    expect(old.status).toBe(426);
    expect(await old.json()).toEqual({ error: 'update_required', minVersion: 'v0.0.10' });
    expect((await post()).status).toBe(426);
    expect(authenticateDaemon).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();

    const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/phone/live?helperVersion=v0.0.9`,
      ['bearer.bdt_test']);
    sockets.push(socket);
    const rejected = new Promise<number>((resolve, reject) => {
      socket.once('unexpected-response', (_request, response) => resolve(response.statusCode ?? 0));
      socket.once('error', reject);
    });
    await expect(rejected).resolves.toBe(426);
    expect(authenticateDaemon).not.toHaveBeenCalled();
    expect(canReadRooms).not.toHaveBeenCalled();

    const current = await post('v0.0.10');
    expect(current.status).toBe(200);
    expect(authenticateDaemon).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();

    const currentSocket = new WebSocket(
      `ws://127.0.0.1:${port}/v1/phone/live?helperVersion=v0.0.10&sourceSha=${'a'.repeat(40)}`,
      ['bearer.bdt_test'],
    );
    sockets.push(currentSocket);
    const hello = new Promise<Record<string, unknown>>((resolve) =>
      currentSocket.once('message', (raw) => resolve(JSON.parse(String(raw)) as Record<string, unknown>)));
    await expect(hello).resolves.toMatchObject({
      type: 'hello', reportedHelper: { releaseVersion: 'v0.0.10', sourceSha: 'a'.repeat(40) },
    });
    expect(canReadRooms).not.toHaveBeenCalled();
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    expect((await health.json()).live.helperMinimum).toEqual({
      minVersion: 'v0.0.10', refusals: 3, forceUpdates: 0,
    });
  });

  it('pushes force-update and gates further work as soon as an authorized release raises the minimum', async () => {
    const gate = new HelperVersionGate();
    const authenticateDaemon = vi.fn().mockResolvedValue('agent');
    const canReadRooms = vi.fn();
    const server = createBeelineServer({
      database: { query: vi.fn(), transaction: vi.fn() },
      auth: { authenticateDaemon } as unknown as TokenAuth,
      phone: { canReadRooms } as unknown as PhoneService,
      daemon: { execute: vi.fn().mockResolvedValue({ commandProtocol: 1, commands: [] }) } as unknown as DaemonService,
      live: new LiveHub(), mediaMaximumBytes: 1,
      helperVersionGate: gate,
      releaseNotify: { secret: 'release-secret', subscribeHelperRelease: vi.fn(() => () => {}) } as unknown as ReleaseNotifier,
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/phone/live?helperVersion=v0.0.9`,
      ['bearer.bdt_test']);
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve); socket.once('error', reject);
    });
    const forced = new Promise<Record<string, unknown>>((resolve) => {
      socket.on('message', (raw) => {
        const event = JSON.parse(String(raw)) as Record<string, unknown>;
        if (event.type === 'force-update') resolve(event);
      });
    });
    const closed = new Promise<number>((resolve) => socket.once('close', resolve));
    const update = await fetch(`http://127.0.0.1:${port}/v1/releases/helper-minimum`, {
      method: 'POST', headers: { authorization: 'Bearer release-secret',
        'content-type': 'application/json' },
      body: JSON.stringify({ minVersion: 'v0.0.10' }),
    });
    expect(update.status).toBe(200);
    expect(await update.json()).toEqual({ minVersion: 'v0.0.10' });
    await expect(forced).resolves.toEqual({ type: 'force-update', minVersion: 'v0.0.10' });
    await expect(closed).resolves.toBe(1008);
    expect(canReadRooms).not.toHaveBeenCalled();
    expect(gate.minimum).toBe('v0.0.10');
    const version = await fetch(`http://127.0.0.1:${port}/version`);
    expect((await version.json()).minimumHelperVersion).toBe('v0.0.10');
  });
});
