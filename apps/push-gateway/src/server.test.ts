import { once } from 'node:events';
import { type AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { TokenRegistry } from './registry.js';
import { createRegistrationServer } from './server.js';

const PUBKEY = 'a'.repeat(64);
const TOKEN = 'fcm-token-A_12345678901234567890';

describe('registration server', () => {
  const servers: ReturnType<typeof createRegistrationServer>[] = [];

  afterEach(async () => {
    await Promise.all(
      servers
        .splice(0)
        .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
  });

  it.each(['test', 'emulator', 'simulator'])('ignores %s device tokens', async (environment) => {
    const registry = await TokenRegistry.load();
    const server = createRegistrationServer(registry);
    servers.push(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const { port } = server.address() as AddressInfo;

    const response = await fetch(`http://127.0.0.1:${port}/registrations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pubkey: PUBKEY, token: TOKEN, platform: 'android', environment }),
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      registered: false,
      ignored: 'non-production-device',
    });
    expect(registry.tokenCount).toBe(0);
  });
});
