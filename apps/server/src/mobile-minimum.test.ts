import type { AddressInfo } from 'node:net';
import { afterEach, expect, it, vi } from 'vitest';
import { createBeelineServer } from './server.js';
import type { TokenAuth } from './auth.js';
import type { PhoneService } from './phone-service.js';
import type { DaemonService } from './daemon-service.js';
import type { ReleaseNotifier } from './release-notify.js';
import { LiveHub } from './live.js';
import { PgliteDatabase } from './test-support.js';
import { MOBILE_MINIMUM_SCHEMA } from './mobile-minimum.js';

const servers: ReturnType<typeof createBeelineServer>[] = [];
const databases: PgliteDatabase[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(s => new Promise<void>(r => s.close(() => r()))));
  await Promise.all(databases.splice(0).map(db => db.close()));
});

it('serves signed-out platform minimums, authenticates writes and persists across server instances', async () => {
  const database = new PgliteDatabase(); databases.push(database);
  await database.query(MOBILE_MINIMUM_SCHEMA);
  const authenticatePhone = vi.fn();
  const start = async () => {
    const server = createBeelineServer({ database,
      auth: { authenticatePhone } as unknown as TokenAuth,
      phone: {} as PhoneService, daemon: {} as DaemonService, live: new LiveHub(), mediaMaximumBytes: 1,
      releaseNotify: { secret: 'test-release-secret', subscribeHelperRelease: () => () => {} } as unknown as ReleaseNotifier,
    });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  };
  const url = await start();
  const read = async (base = url) => (await fetch(`${base}/v1/public/mobile-minimum`)).json();
  expect(await read()).toEqual({});
  const write = (payload: unknown, authorized = true) => fetch(`${url}/v1/releases/mobile-minimum`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(authorized ? { authorization: 'Bearer test-release-secret' } : {}) },
    body: JSON.stringify(payload),
  });
  const android = { platform: 'android', minVersion: '0.2.24', reason: 'This version can no longer sign in.' };
  expect((await write(android, false)).status).toBe(403);
  expect((await write({ ...android, minVersion: 'invalid' })).status).toBe(400);
  expect((await write({ ...android, reason: ' ' })).status).toBe(400);
  expect((await write({ ...android, platform: 'web' })).status).toBe(400);
  expect((await write(android)).status).toBe(200);
  expect(await read()).toEqual({ android: { minVersion: android.minVersion, reason: android.reason } });
  expect((await write({ platform: 'ios', minVersion: '0.3.0', reason: 'A store update is required.' })).status).toBe(200);
  expect(await read(await start())).toEqual({
    android: { minVersion: android.minVersion, reason: android.reason },
    ios: { minVersion: '0.3.0', reason: 'A store update is required.' },
  });
  expect(authenticatePhone).not.toHaveBeenCalled();
}, 20000);
