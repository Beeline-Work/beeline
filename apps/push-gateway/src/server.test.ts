import { once } from 'node:events';
import { type AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nip98AuthHeader, type NostrEvent } from '@beeline/nostr';
import type { Messaging } from 'firebase-admin/messaging';
import { createIdentity } from '@beeline/buzz-client';
import { DeliveryState } from './delivery-state.js';
import { PushGateway } from './gateway.js';
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

describe('POST /test-send', () => {
  const servers: ReturnType<typeof createRegistrationServer>[] = [];

  afterEach(async () => {
    await Promise.all(
      servers
        .splice(0)
        .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
  });

  async function serverWithGateway(messaging: Messaging) {
    const registry = await TokenRegistry.load();
    const gateway = new PushGateway(registry, messaging, await DeliveryState.load());
    return createRegistrationServer(registry, {
      sendTest: (pubkey) => gateway.sendTestNotification(pubkey),
    });
  }

  async function listen(server: ReturnType<typeof createRegistrationServer>): Promise<string> {
    servers.push(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const { port } = server.address() as AddressInfo;
    return `http://127.0.0.1:${port}/test-send`;
  }

  it('refuses an unauthenticated or foreign-identity test send', async () => {
    const url = await listen(await serverWithGateway({} as Messaging));

    const anonymous = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pubkey: PUBKEY }),
    });
    expect(anonymous.status).toBe(401);

    const identity = createIdentity('attacker');
    const forged = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: nip98AuthHeader(identity.secretKey, identity.publicKey, url, 'POST'),
      },
      body: JSON.stringify({ pubkey: PUBKEY }),
    });
    expect(forged.status).toBe(401);
  });

  it('sends a real-shaped FCM notification and reports per-device results', async () => {
    const owner = createIdentity('owner');
    const sendEachForMulticast = vi.fn(async () => ({
      successCount: 1,
      failureCount: 1,
      responses: [
        { success: true, messageId: 'projects/buzzy-e11e7/messages/1' },
        { success: false, error: { code: 'messaging/internal-error' } },
      ],
    }));
    const registry = await TokenRegistry.load();
    await registry.register(owner.publicKey, TOKEN);
    await registry.register(owner.publicKey, 'fcm-token-second_123456789012345678');
    const gateway = new PushGateway(
      registry,
      { sendEachForMulticast } as unknown as Messaging,
      await DeliveryState.load(),
    );
    const server = createRegistrationServer(registry, {
      sendTest: (pubkey) => gateway.sendTestNotification(pubkey),
    });
    const url = `http://127.0.0.1:${await (async () => {
      servers.push(server);
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      return (server.address() as AddressInfo).port;
    })()}/test-send`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // Production relay-front strips /push before forwarding to this native
        // route, but the NIP-98 event correctly signs the public URL.
        authorization: nip98AuthHeader(
          owner.secretKey,
          owner.publicKey,
          'https://usebeeline.app/push/test-send',
          'POST',
        ),
      },
      body: JSON.stringify({ pubkey: owner.publicKey }),
    });

    // eslint-disable-next-line no-console
    expect(response.status).toBe(200);
    const report = await response.json();
    expect(report).toMatchObject({
      pubkey: owner.publicKey,
      successCount: 1,
      failureCount: 1,
      devices: [
        {
          deviceId: expect.stringMatching(/^[0-9a-f]{16}$/),
          ok: true,
          messageId: 'projects/buzzy-e11e7/messages/1',
        },
        {
          deviceId: expect.stringMatching(/^[0-9a-f]{16}$/),
          ok: false,
          error: 'messaging/internal-error',
        },
      ],
    });
    expect(JSON.stringify(report)).not.toContain(TOKEN);
    expect(JSON.stringify(report)).not.toContain('fcm-token-second_123456789012345678');
    expect(sendEachForMulticast.mock.calls[0]?.[0]).toMatchObject({
      tokens: [TOKEN, 'fcm-token-second_123456789012345678'],
      notification: { title: 'Beeline push test' },
      data: { type: 'delivery-test' },
    });
  });

  it('reports a registered pubkey with zero devices as an empty list', async () => {
    const owner = createIdentity('lonely');
    const sendEachForMulticast = vi.fn();
    const registry = await TokenRegistry.load();
    const gateway = new PushGateway(
      registry,
      { sendEachForMulticast } as unknown as Messaging,
      await DeliveryState.load(),
    );
    const server = createRegistrationServer(registry, {
      sendTest: (pubkey) => gateway.sendTestNotification(pubkey),
    });
    servers.push(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = (server.address() as AddressInfo).port;
    const url = `http://127.0.0.1:${port}/test-send`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: nip98AuthHeader(owner.secretKey, owner.publicKey, url, 'POST'),
      },
      body: JSON.stringify({ pubkey: owner.publicKey }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      pubkey: owner.publicKey,
      successCount: 0,
      failureCount: 0,
      devices: [],
    });
    expect(sendEachForMulticast).not.toHaveBeenCalled();
  });
});
