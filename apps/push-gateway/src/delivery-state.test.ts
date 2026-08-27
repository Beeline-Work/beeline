import { describe, expect, it } from 'vitest';
import {
  DeliveryState,
  type DeliveryStateFile,
  type DeliveryStatePersistence,
} from './delivery-state.js';

const PUBKEY = 'a'.repeat(64);

function durableState(): {
  persistence: DeliveryStatePersistence;
  value: () => DeliveryStateFile | undefined;
} {
  let value: DeliveryStateFile | undefined;
  return {
    persistence: {
      load: async () => structuredClone(value),
      save: async (next) => {
        value = structuredClone(next);
      },
    },
    value: () => structuredClone(value),
  };
}

describe('DeliveryState', () => {
  it('persists a spent attention episode until it is cleared explicitly', async () => {
    const durable = durableState();
    const sourceId = 'corner-peddle';
    const first = await DeliveryState.load(durable.persistence, { now: () => 200_000 });

    await expect(
      first.reserveAttentionAttempt({
        eventId: '1'.repeat(64),
        eventCreatedAt: 100,
        pubkey: PUBKEY,
        sourceId,
        reason: 'review',
      }),
    ).resolves.toBe(true);

    const restarted = await DeliveryState.load(durable.persistence, { now: () => 900_000 });
    await expect(
      restarted.reserveAttentionAttempt({
        eventId: '2'.repeat(64),
        eventCreatedAt: 101,
        pubkey: PUBKEY,
        sourceId,
        reason: 'review',
      }),
    ).resolves.toBe(false);

    await restarted.clearAttention(sourceId, PUBKEY);
    await expect(
      restarted.reserveAttentionAttempt({
        eventId: '3'.repeat(64),
        eventCreatedAt: 102,
        pubkey: PUBKEY,
        sourceId,
        reason: 'review',
      }),
    ).resolves.toBe(true);
  });

  it('persists an FCM attempt before delivery and treats it as terminal after restart', async () => {
    const durable = durableState();
    const eventId = 'b'.repeat(64);
    const state = await DeliveryState.load(durable.persistence, { now: () => 200_000 });

    await expect(state.reserveAttempt(eventId, 100, PUBKEY)).resolves.toBe(true);
    const attempted = durable.value()!;
    expect(attempted.events[0]?.recipients[0]?.status).toBe('attempted');

    const restarted = await DeliveryState.load(durable.persistence, { now: () => 201_000 });
    await expect(restarted.reserveAttempt(eventId, 100, PUBKEY)).resolves.toBe(false);
    await restarted.markDelivered(eventId, PUBKEY);

    const delivered = durable.value()!;
    expect(delivered.events[0]?.recipients[0]?.status).toBe('delivered');
  });

  it('bounds old event ids only after a durable cursor makes replay ineligible', async () => {
    const durable = durableState();
    const state = await DeliveryState.load(durable.persistence, {
      now: () => 200_000,
      retentionMs: Number.MAX_SAFE_INTEGER,
      maxEvents: 2,
    });

    for (const [index, id] of ['1', '2', '3'].entries()) {
      await state.reserveAttempt(id.repeat(64), index + 1, PUBKEY);
      await state.markDelivered(id.repeat(64), PUBKEY);
      await state.advanceCursor(PUBKEY, index + 1);
    }

    const persisted = durable.value()!;
    expect(persisted.events).toHaveLength(2);
    expect(persisted.cursors[0]?.throughCreatedAt).toBe(3);

    const restarted = await DeliveryState.load(durable.persistence, {
      now: () => 201_000,
      retentionMs: Number.MAX_SAFE_INTEGER,
      maxEvents: 2,
    });
    await expect(restarted.reserveAttempt('1'.repeat(64), 1, PUBKEY)).resolves.toBe(false);
  });
});
