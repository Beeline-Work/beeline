import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { newIdentity } from '@beeline/gate';
import { signEvent } from '@beeline/nostr';
import { DURABLE_BODY_STATE_VERSION, DurableBodyState } from './durable-state.js';
import fixtureManifest from './fixtures/durable-state/manifest.json';

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('durable state schema migration', () => {
  it('keeps a golden fixture for the current durable format', () => {
    expect(fixtureManifest.currentVersion).toBe(DURABLE_BODY_STATE_VERSION);
    expect(fixtureManifest.fixtures.map((fixture) => fixture.version)).toContain(
      DURABLE_BODY_STATE_VERSION,
    );
  });

  it.each(fixtureManifest.fixtures)(
    'loads release $release golden state v$version with the current migration registry',
    async ({ file, version }) => {
      const root = await mkdtemp(resolve(tmpdir(), `beeline-golden-v${version}-`));
      cleanup.push(root);
      const path = resolve(root, 'state.json');
      const fixture = resolve(import.meta.dirname, 'fixtures', 'durable-state', file);
      await writeFile(path, await readFile(fixture));

      const state = new DurableBodyState(path);
      expect((await state.cursor('released-room')).eventId).toBe(`released-v${version}-cursor`);
      expect(await state.pending('released-room')).toEqual([]);
    },
  );

  it('migrates version 1 inboxes and cursors to version 2 in memory', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'beeline-state-v1-'));
    cleanup.push(root);
    const path = resolve(root, 'state.json');
    const identity = newIdentity('migration-inbox');
    const pendingEvent = signEvent(
      {
        pubkey: identity.publicKey,
        created_at: 1_699_999_999,
        kind: 9,
        tags: [['h', 'room']],
        content: 'Preserve this pending inbox item.',
      },
      identity.secretKey,
    );
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        inboxes: {
          room: {
            cursor: { createdAt: 1_700_000_000, eventId: 'last-delivered-event' },
            items: {
              [pendingEvent.id]: {
                event: pendingEvent,
                state: 'pending',
                attempts: 2,
                lastError: 'temporary relay failure',
              },
            },
          },
        },
      }),
    );

    const state = new DurableBodyState(path);
    expect(await state.cursor('room')).toEqual({
      createdAt: 1_700_000_000,
      eventId: 'last-delivered-event',
    });
    expect((await state.pending('room')).map((event) => event.id)).toEqual([pendingEvent.id]);
  });

  it('loads an existing version 2 file while ignoring its retired read model field', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'beeline-state-v2-'));
    cleanup.push(root);
    const path = resolve(root, 'state.json');
    const persisted = `${JSON.stringify({
      version: 2,
      inboxes: {
        room: {
          cursor: { createdAt: 42, eventId: 'v2-cursor' },
          items: {},
        },
      },
      readModels: { room: { schemaVersion: 1, retired: true } },
    })}\n`;
    await writeFile(path, persisted);

    const state = new DurableBodyState(path);
    expect(await state.cursor('room')).toEqual({ createdAt: 42, eventId: 'v2-cursor' });
    expect(await readFile(path, 'utf8')).toBe(persisted);
  });

  it('discards malformed retired read model data on the next durable save', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'beeline-state-invalid-v2-model-'));
    cleanup.push(root);
    const path = resolve(root, 'state.json');
    await writeFile(
      path,
      JSON.stringify({
        version: 2,
        inboxes: {
          room: {
            cursor: { createdAt: 7, eventId: 'preserved' },
            items: {},
          },
        },
        readModels: { room: { schemaVersion: 1, workspaceId: 'room' } },
      }),
    );

    const state = new DurableBodyState(path);
    const identity = newIdentity('retired-read-model-save');
    await state.enqueue('room', [
      signEvent(
        {
          pubkey: identity.publicKey,
          created_at: 8,
          kind: 9,
          tags: [['h', 'room']],
          content: 'Trigger a durable save.',
        },
        identity.secretKey,
      ),
    ]);
    const persisted = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    expect(persisted).not.toHaveProperty('readModels');
  });

  it('fails closed on malformed persisted JSON', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'beeline-state-malformed-'));
    cleanup.push(root);
    const path = resolve(root, 'state.json');
    await writeFile(path, '{"version": 1, definitely not valid JSON');

    const state = new DurableBodyState(path);
    await expect(state.cursor('room')).rejects.toBeInstanceOf(SyntaxError);
  });

  it.each([
    ['missing inboxes', { version: 1 }],
    ['non-object inboxes', { version: 1, inboxes: [] }],
  ])('fails closed on version 1 state with %s', async (_description, persisted) => {
    const root = await mkdtemp(resolve(tmpdir(), 'beeline-state-invalid-v1-'));
    cleanup.push(root);
    const path = resolve(root, 'state.json');
    await writeFile(path, JSON.stringify(persisted));

    const state = new DurableBodyState(path);
    await expect(state.cursor('room')).rejects.toThrow(`unsupported durable body state at ${path}`);
  });

  it('persists only version 2 fields while preserving operational state', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'beeline-state-roundtrip-'));
    cleanup.push(root);
    const path = resolve(root, 'state.json');
    const identity = newIdentity('migration-roundtrip');
    const event = signEvent(
      {
        pubkey: identity.publicKey,
        created_at: 100,
        kind: 9,
        tags: [['h', 'other-room']],
        content: 'Trigger the next durable save.',
      },
      identity.secretKey,
    );
    const modelTurn = {
      requestId: 'request',
      originalRequestId: 'request',
      cause: 'room-message',
      agentPubkey: identity.publicKey,
      channelId: 'room',
      startedAt: '2026-08-25T12:00:00.000Z',
      status: 'complete',
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      tokenSource: 'reported',
      toolCalls: 1,
    };
    const sessionReprime = {
      agentPubkey: identity.publicKey,
      channelId: 'room',
      processGeneration: 'generation',
      at: '2026-08-25T12:01:00.000Z',
      entries: 2,
      beforeChars: 20,
      afterChars: 10,
      beforeTokens: 5,
      afterTokens: 3,
    };
    const factory = {
      version: 1,
      permissionActionClaims: ['permission-claim'],
    };
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        inboxes: {
          room: {
            cursor: { createdAt: 99, eventId: 'preserved-cursor' },
            items: {},
          },
        },
        conversations: {
          room: [{ role: 'agent', text: 'Retired presentation prose must not survive.' }],
        },
        modelTurns: [modelTurn],
        sessionReprimes: [sessionReprime],
        githubEventCursors: { room: 77 },
        factory,
      }),
    );

    const migrated = new DurableBodyState(path);
    await migrated.enqueue('other-room', [event]);

    const persisted = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    expect(persisted.version).toBe(2);
    expect(persisted).not.toHaveProperty('readModels');
    expect(persisted).not.toHaveProperty('conversations');
    expect(persisted.modelTurns).toEqual([modelTurn]);
    expect(persisted.sessionReprimes).toEqual([sessionReprime]);
    expect(persisted.githubEventCursors).toEqual({ room: 77 });
    expect(persisted).not.toHaveProperty('concludeEpisodes');
    expect(persisted.factory).toEqual(factory);
    const restarted = new DurableBodyState(path);
    expect(await restarted.cursor('room')).toEqual({
      createdAt: 99,
      eventId: 'preserved-cursor',
    });
    expect((await restarted.pending('other-room')).map((item) => item.id)).toEqual([event.id]);
    expect(await restarted.modelTurns()).toEqual([modelTurn]);
    expect(await restarted.sessionReprimes()).toEqual([sessionReprime]);
    expect(await restarted.githubEventCursor('room')).toBe(77);
    expect(await restarted.claimPermissionAction('permission-claim')).toBe('duplicate');
  });
});

describe('durable input inbox', () => {
  it('survives restart and keeps a failed older event pending after newer delivery', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'beeline-inbox-'));
    cleanup.push(root);
    const path = resolve(root, 'state.json');
    const identity = newIdentity('human');
    const events = Array.from({ length: 101 }, (_, index) =>
      signEvent(
        {
          pubkey: identity.publicKey,
          created_at: 1_700_000_000 + Math.floor(index / 20),
          kind: 9,
          tags: [['h', 'corner']],
          content: `message-${index}`,
        },
        identity.secretKey,
      ),
    );
    const first = new DurableBodyState(path);
    expect(await first.enqueue('corner', events)).toBe(101);
    await first.failed('corner', events[0]!.id, new Error('temporary'));
    for (const event of events.slice(1)) await first.delivered('corner', event.id);

    const restarted = new DurableBodyState(path);
    const pending = await restarted.pending('corner');
    expect(pending.map((event) => event.id)).toEqual([events[0]!.id]);
    expect((await restarted.cursor('corner')).createdAt).toBe(events[100]!.created_at);
  });

  it('persists one reserved reply so a retry reuses its event id', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'beeline-inbox-reply-'));
    cleanup.push(root);
    const path = resolve(root, 'state.json');
    const human = newIdentity('human');
    const agent = newIdentity('agent');
    const request = signEvent(
      {
        pubkey: human.publicKey,
        created_at: 1_700_000_000,
        kind: 9,
        tags: [['h', 'room']],
        content: 'Reply once.',
      },
      human.secretKey,
    );
    const reply = signEvent(
      {
        pubkey: agent.publicKey,
        created_at: 1_700_000_001,
        kind: 9,
        tags: [
          ['h', 'room'],
          ['e', request.id, '', 'reply'],
        ],
        content: 'One reply.',
      },
      agent.secretKey,
    );

    const first = new DurableBodyState(path);
    await first.enqueue('room', [request]);
    expect((await first.reserveReply('room', request.id, reply)).id).toBe(reply.id);

    const restarted = new DurableBodyState(path);
    expect((await restarted.reply('room', request.id))?.id).toBe(reply.id);
    const differentReply = signEvent(
      { ...reply, created_at: reply.created_at + 1, content: 'A duplicate reply.' },
      agent.secretKey,
    );
    expect((await restarted.reserveReply('room', request.id, differentReply)).id).toBe(reply.id);
  });

  it('keeps model-call attribution inspectable across restart', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'beeline-model-spend-'));
    cleanup.push(root);
    const path = resolve(root, 'state.json');
    const first = new DurableBodyState(path);
    await first.recordModelTurn({
      agentPubkey: 'agent',
      channelId: 'corner',
      requestId: 'restart-1',
      originalRequestId: 'human-request',
      cause: 'restart-continuation',
      startedAt: '2026-08-20T12:00:00.000Z',
      status: 'complete',
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      tokenSource: 'estimated',
      toolCalls: 3,
    });

    const restarted = new DurableBodyState(path);
    expect(await restarted.modelTurns()).toEqual([
      expect.objectContaining({
        cause: 'restart-continuation',
        originalRequestId: 'human-request',
        totalTokens: 120,
      }),
    ]);
    await first.recordSessionReprime({
      agentPubkey: 'agent',
      channelId: 'corner',
      processGeneration: 'restart-1',
      at: '2026-08-20T12:00:00.000Z',
      entries: 200,
      beforeChars: 114_000,
      afterChars: 8_000,
      beforeTokens: 28_500,
      afterTokens: 2_000,
    });
    const restartedAgain = new DurableBodyState(path);
    expect(await restartedAgain.sessionReprimes()).toEqual([
      expect.objectContaining({ processGeneration: 'restart-1', afterTokens: 2_000 }),
    ]);
  });
});

describe('factory capacity reservations', () => {
  it('retains undelivered permission receipts across restart and removes delivered work', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'beeline-permission-outbox-'));
    cleanup.push(root);
    const path = resolve(root, 'state.json');
    const identity = newIdentity('permission-agent');
    const receipt = signEvent(
      {
        pubkey: identity.publicKey,
        created_at: 1_700_000_000,
        kind: 9,
        tags: [['t', 'factory-permission-execution']],
        content: JSON.stringify({ status: 'failed' }),
      },
      identity.secretKey,
    );
    const first = new DurableBodyState(path);
    await first.reservePermissionReceipt(receipt);

    const restarted = new DurableBodyState(path);
    expect((await restarted.pendingPermissionReceipts()).map((event) => event.id)).toEqual([
      receipt.id,
    ]);
    await restarted.markPermissionReceiptDelivered(receipt.id);

    const delivered = new DurableBodyState(path);
    expect(await delivered.pendingPermissionReceipts()).toEqual([]);
  });

  it('atomically admits only one concurrent action into a one-use grant', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'beeline-permission-capacity-'));
    cleanup.push(root);
    const state = new DurableBodyState(resolve(root, 'state.json'));
    const base = {
      grantEventId: 'grant',
      at: 1_000,
      charge: { uses: 1 },
      usage: {
        uses: 0,
        minorUnits: 0,
        reservedTokens: 0,
        committedAt: [],
        actionStatuses: new Map(),
      },
      grant: {
        tier: 1 as const,
        mode: 'standing' as const,
        notBefore: 900,
        expiresAt: 2_000,
        maxUses: 1,
        budget: {},
        rate: { maxUses: 1, windowSeconds: 60 },
      },
    };
    const results = await Promise.all([
      state.reservePermissionCapacity({ ...base, key: 'a:1', actionId: 'a' }),
      state.reservePermissionCapacity({ ...base, key: 'b:1', actionId: 'b' }),
    ]);
    expect(results.sort()).toEqual(['claimed', 'exhausted']);
  });
});
