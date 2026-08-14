import { once } from 'node:events';
import { type AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { nip98AuthHeader } from '@beeline/nostr';
import { createIdentity } from '@beeline/buzz-client';
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

  it('lets only the bound identity unregister its own device token', async () => {
    const identity = createIdentity('push-owner');
    const registry = await TokenRegistry.load();
    await registry.register(identity.publicKey, TOKEN);
    const server = createRegistrationServer(registry);
    servers.push(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const { port } = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${port}/registrations`;

    const denied = await fetch(url, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pubkey: identity.publicKey, token: TOKEN }),
    });
    expect(denied.status).toBe(401);
    expect(registry.tokenCount).toBe(1);

    const removed = await fetch(url, {
      method: 'DELETE',
      headers: {
        'content-type': 'application/json',
        authorization: nip98AuthHeader(identity.secretKey, identity.publicKey, url, 'DELETE'),
      },
      body: JSON.stringify({ pubkey: identity.publicKey, token: TOKEN }),
    });
    expect(removed.status).toBe(200);
    await expect(removed.json()).resolves.toEqual({ registered: false });
    expect(registry.tokenCount).toBe(0);
  });
});
