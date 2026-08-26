import { once } from 'node:events';
import { type AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { PGlite, type Transaction } from '@electric-sql/pglite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nip98AuthHeader, type NostrEvent } from '@beeline/nostr';
import type { Messaging } from 'firebase-admin/messaging';
import {
  createIdentity,
  CHANNEL_SNAPSHOT_MAX_BYTES,
  channelSnapshotDigest,
  guardChannelSnapshotViewV1,
  type StoredChannelSnapshotV1,
} from '@beeline/buzz-client';
import type { DatabaseQueryable, DatabaseTransactional } from './database.js';
import { DeliveryState } from './delivery-state.js';
import { PushGateway } from './gateway.js';
import { TokenRegistry } from './registry.js';
import { createRegistrationServer, type RegistrationServerHooks } from './server.js';
import { ChannelSnapshotStore } from './snapshot-store.js';

const PUBKEY = 'a'.repeat(64);
const TOKEN = 'fcm-token-A_12345678901234567890';

class PgliteDatabase implements DatabaseTransactional {
  constructor(private readonly postgres: PGlite) {}

  async query<Row>(text: string, values?: unknown[]) {
    if (values === undefined && text.includes('CREATE TABLE')) {
      await this.postgres.exec(text);
      return { rows: [] as Row[] };
    }
    const result = await this.postgres.query<Row>(text, values as never[] | undefined);
    return { rows: result.rows };
  }

  async transaction<T>(work: (database: DatabaseQueryable) => Promise<T>): Promise<T> {
    return this.postgres.transaction(async (transaction: Transaction) =>
      work({
        query: async <Row>(text: string, values?: unknown[]) => {
          const result = await transaction.query<Row>(text, values as never[] | undefined);
          return { rows: result.rows };
        },
      }),
    );
  }
}

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

describe('GET /snapshot/channel/:channelId', () => {
  const PUBLIC_ORIGIN = 'https://usebeeline.app';
  const CHANNEL = '9b929b0d-5189-4dbf-b6ba-a9f4ddf81bc6';
  const servers: ReturnType<typeof createRegistrationServer>[] = [];

  afterEach(async () => {
    await Promise.all(
      servers
        .splice(0)
        .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
  });

  function golden() {
    const view = JSON.parse(
      readFileSync(
        new URL(
          '../../../packages/buzz-client/src/read-model/fixtures/channel-snapshot-v1.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ) as Record<string, unknown>;
    const { lagMs: _lag, viewer: _viewer, integrity, ...payload } = view;
    return {
      payload: payload as StoredChannelSnapshotV1,
      digest: (integrity as { digest: string }).digest,
    };
  }

  function normalizedStoredPayload(value: unknown): StoredChannelSnapshotV1 {
    const candidate = value as StoredChannelSnapshotV1;
    return {
      capability: candidate.capability,
      schemaVersion: candidate.schemaVersion,
      projectionVersion: candidate.projectionVersion,
      channelId: candidate.channelId,
      revision: candidate.revision,
      projectedAt: candidate.projectedAt,
      cursor: candidate.cursor,
      identitiesStale: candidate.identitiesStale,
      snapshot: candidate.snapshot,
      ...(candidate.repository ? { repository: candidate.repository } : {}),
      review: candidate.review,
    };
  }

  async function listen(
    readForViewer: NonNullable<RegistrationServerHooks['snapshot']>['readForViewer'],
    options: {
      pushHealth?: RegistrationServerHooks['pushHealth'];
      snapshotStatus?: NonNullable<RegistrationServerHooks['snapshot']>['status'];
      snapshotClaim?: NonNullable<RegistrationServerHooks['snapshot']>['claimNip98Event'];
      snapshotLog?: NonNullable<RegistrationServerHooks['snapshot']>['log'];
    } = {},
  ) {
    const registry = await TokenRegistry.load();
    const claimed = new Set<string>();
    const server = createRegistrationServer(registry, {
      ...(options.pushHealth ? { pushHealth: options.pushHealth } : {}),
      snapshot: {
        publicOrigin: PUBLIC_ORIGIN,
        readForViewer,
        claimNip98Event:
          options.snapshotClaim ??
          (async (eventId) => {
            if (claimed.has(eventId)) return false;
            claimed.add(eventId);
            return true;
          }),
        ...(options.snapshotStatus ? { status: options.snapshotStatus } : {}),
        ...(options.snapshotLog ? { log: options.snapshotLog } : {}),
      },
    });
    servers.push(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it('keeps snapshot health available when Firebase push readiness is down', async () => {
    const base = await listen(async () => null, {
      pushHealth: () => ({ ok: false, reason: 'firebase_unavailable' }),
      snapshotStatus: async () => ({ depth: 3, oldestDirtyAgeMs: 25, warmed: false }),
    });
    const [push, snapshot] = await Promise.all([
      fetch(`${base}/health`),
      fetch(`${base}/snapshot/health`),
    ]);
    expect(push.status).toBe(503);
    expect(snapshot.status).toBe(200);
    await expect(snapshot.json()).resolves.toEqual({
      ok: true,
      depth: 3,
      oldestDirtyAgeMs: 25,
      warmed: false,
    });
  });

  function authorization(identity: ReturnType<typeof createIdentity>, path: string) {
    return nip98AuthHeader(
      identity.secretKey,
      identity.publicKey,
      `${PUBLIC_ORIGIN}${path}`,
      'GET',
    );
  }

  it('serves a membership-gated PostgreSQL snapshot in under 300ms', async () => {
    const identity = createIdentity('snapshot-member');
    const { payload, digest } = golden();
    const postgres = new PGlite();
    await postgres.waitReady;
    const database = new PgliteDatabase(postgres);
    await postgres.exec(`
      CREATE TABLE channels (
        community_id uuid NOT NULL,
        id uuid NOT NULL,
        visibility text NOT NULL DEFAULT 'private',
        deleted_at timestamptz,
        PRIMARY KEY (community_id, id)
      );
      CREATE TABLE channel_members (
        community_id uuid NOT NULL,
        channel_id uuid NOT NULL,
        pubkey bytea NOT NULL,
        removed_at timestamptz
      );
      CREATE TABLE events (
        community_id uuid NOT NULL,
        id bytea NOT NULL,
        pubkey bytea NOT NULL,
        created_at timestamptz NOT NULL,
        kind integer NOT NULL,
        tags jsonb NOT NULL,
        content text NOT NULL,
        sig bytea NOT NULL,
        channel_id uuid,
        deleted_at timestamptz
      );
    `);
    const store = new ChannelSnapshotStore(database);
    await store.migrate();
    try {
      await database.query(`INSERT INTO channels (community_id, id) VALUES ($1, $2)`, [
        'e8299f28-f095-472f-941a-80d1195b9a24',
        CHANNEL,
      ]);
      await database.query(
        `INSERT INTO channel_members (community_id, channel_id, pubkey)
         VALUES ($1, $2, decode($3, 'hex'))`,
        ['e8299f28-f095-472f-941a-80d1195b9a24', CHANNEL, identity.publicKey],
      );
      const [claim] = await store.claimDirty(1, 60_000);
      await store.complete(claim!, payload, digest);
      const roundTripped = await store.readForViewer(CHANNEL, identity.publicKey);
      const databaseDigest = channelSnapshotDigest(normalizedStoredPayload(roundTripped!.payload));
      await database.query(
        `UPDATE beeline_channel_snapshot_v1 SET payload_sha256 = $1
         WHERE relay_tenant_id = $2 AND channel_id = $3`,
        [databaseDigest, 'e8299f28-f095-472f-941a-80d1195b9a24', CHANNEL],
      );

      const registry = await TokenRegistry.load();
      const server = createRegistrationServer(registry, {
        snapshot: {
          publicOrigin: PUBLIC_ORIGIN,
          readForViewer: (channelId, pubkey) => store.readForViewer(channelId, pubkey),
          claimNip98Event: (eventId) => store.claimNip98Event(eventId),
        },
      });
      servers.push(server);
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const path = `/snapshot/channel/${CHANNEL}`;
      const startedAt = performance.now();
      const response = await fetch(`${base}${path}`, {
        headers: { authorization: authorization(identity, path) },
      });
      const elapsed = performance.now() - startedAt;

      expect(response.status).toBe(200);
      expect(elapsed).toBeLessThan(300);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      expect(response.headers.get('vary')).toBe('Authorization');
      expect(response.headers.get('x-beeline-snapshot-integrity')).toBe(databaseDigest);
      expect(guardChannelSnapshotViewV1(await response.json())).toMatchObject({ status: 'ready' });

      await database.query(
        `UPDATE channel_members SET removed_at = now()
         WHERE community_id = $1 AND channel_id = $2 AND pubkey = decode($3, 'hex')`,
        ['e8299f28-f095-472f-941a-80d1195b9a24', CHANNEL, identity.publicKey],
      );
      const removed = await fetch(`${base}${path}`, {
        headers: { authorization: authorization(identity, path) },
      });
      expect(removed.status).toBe(404);
    } finally {
      await postgres.close();
    }
  }, 30_000);

  it('returns an indistinguishable 404 for a non-member and a nonexistent channel', async () => {
    const identity = createIdentity('snapshot-outsider');
    const base = await listen(async () => null);
    const paths = [
      `/snapshot/channel/${CHANNEL}`,
      '/snapshot/channel/3f37b271-1a12-4d2a-b002-202b3f3582b9',
    ];
    const responses = await Promise.all(
      paths.map((path) =>
        fetch(`${base}${path}`, { headers: { authorization: authorization(identity, path) } }),
      ),
    );
    expect(responses.map((response) => response.status)).toEqual([404, 404]);
    await expect(Promise.all(responses.map((response) => response.json()))).resolves.toEqual([
      { error: 'not_found' },
      { error: 'not_found' },
    ]);
  });

  it('rejects a wrong exact URL, query alias, and replayed proof', async () => {
    const identity = createIdentity('snapshot-proof');
    const { payload, digest } = golden();
    const base = await listen(async () => ({
      tenantId: 'e8299f28-f095-472f-941a-80d1195b9a24',
      payload,
      digest,
      lagMs: 0,
    }));
    const path = `/snapshot/channel/${CHANNEL}`;
    const wrong = await fetch(`${base}${path}`, {
      headers: {
        authorization: nip98AuthHeader(
          identity.secretKey,
          identity.publicKey,
          `https://attacker.example${path}`,
          'GET',
        ),
      },
    });
    expect(wrong.status).toBe(401);
    const query = await fetch(`${base}${path}?alias=1`, {
      headers: { authorization: authorization(identity, `${path}?alias=1`) },
    });
    expect(query.status).toBe(404);
    const uppercasePath = `/snapshot/channel/${CHANNEL.toUpperCase()}`;
    const caseAlias = await fetch(`${base}${uppercasePath}`, {
      headers: { authorization: authorization(identity, path) },
    });
    expect(caseAlias.status).toBe(404);
    const hostAlias = await fetch(`${base}${path}`, {
      headers: {
        authorization: authorization(identity, path),
        host: 'relay.buzzrouter.com',
        'x-forwarded-proto': 'https',
      },
    });
    expect(hostAlias.status).toBe(401);

    const proof = authorization(identity, path);
    const accepted = await fetch(`${base}${path}`, { headers: { authorization: proof } });
    const replay = await fetch(`${base}${path}`, { headers: { authorization: proof } });
    expect(accepted.status).toBe(200);
    expect(replay.status).toBe(401);
  });

  it('fails closed for stale, missing, or corrupt snapshots', async () => {
    const identity = createIdentity('snapshot-stale');
    const { payload, digest } = golden();
    const rows = [
      { tenantId: 'tenant', lagMs: 30_001, payload, digest },
      { tenantId: 'tenant', lagMs: 0 },
      { tenantId: 'tenant', lagMs: 0, payload, digest: '0'.repeat(64) },
      { tenantId: 'tenant', lagMs: 0, payload: {}, digest },
      { tenantId: 'tenant', lagMs: 0, payload: false, digest },
      { tenantId: 'tenant', lagMs: 0, payload: 0, digest },
      { tenantId: 'tenant', lagMs: 0, payload: '', digest },
    ];
    const base = await listen(async () => rows.shift()!);
    const path = `/snapshot/channel/${CHANNEL}`;
    for (const reason of [
      'stale',
      'missing',
      'incompatible_or_corrupt',
      'incompatible_or_corrupt',
      'incompatible_or_corrupt',
      'incompatible_or_corrupt',
      'incompatible_or_corrupt',
    ]) {
      const response = await fetch(`${base}${path}`, {
        headers: { authorization: authorization(identity, path) },
      });
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({ error: 'snapshot_not_ready', reason });
    }
  });

  it('returns a private retryable 503 for snapshot operational failures', async () => {
    const identity = createIdentity('snapshot-operational-failure');
    const logs: string[] = [];
    let claimAttempts = 0;
    const base = await listen(
      async () => {
        throw new Error('membership query exposed detail');
      },
      {
        snapshotClaim: async () => {
          claimAttempts += 1;
          if (claimAttempts === 1) throw new Error('replay ledger exposed detail');
          return true;
        },
        snapshotLog: (line) => logs.push(line),
      },
    );
    const path = `/snapshot/channel/${CHANNEL}`;

    for (const leakedDetail of [
      'replay ledger exposed detail',
      'membership query exposed detail',
    ]) {
      const response = await fetch(`${base}${path}`, {
        headers: { authorization: authorization(identity, path) },
      });
      expect(response.status).toBe(503);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      expect(response.headers.get('vary')).toBe('Authorization');
      expect(response.headers.get('retry-after')).toBe('1');
      const body = await response.json();
      expect(body).toEqual({
        error: 'snapshot_not_ready',
        reason: 'temporarily_unavailable',
      });
      expect(JSON.stringify(body)).not.toContain(leakedDetail);
    }
    expect(logs.join('\n')).toContain('replay ledger exposed detail');
    expect(logs.join('\n')).toContain('membership query exposed detail');
  });

  it('rejects a validly hashed snapshot whose complete response exceeds the byte cap', async () => {
    const identity = createIdentity('snapshot-byte-cap');
    const { payload } = golden();
    const oversized = structuredClone(payload);
    (oversized.snapshot as unknown as { diagnostics: unknown[] }).diagnostics = [
      'x'.repeat(CHANNEL_SNAPSHOT_MAX_BYTES),
    ];
    const digest = channelSnapshotDigest(oversized);
    const base = await listen(async () => ({
      tenantId: 'tenant',
      lagMs: 0,
      payload: oversized,
      digest,
    }));
    const path = `/snapshot/channel/${CHANNEL}`;
    const response = await fetch(`${base}${path}`, {
      headers: { authorization: authorization(identity, path) },
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: 'snapshot_not_ready',
      reason: 'incompatible_or_corrupt',
    });
  });
});
