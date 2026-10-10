import { describe, expect, it, vi } from 'vitest';

const stores = vi.hoisted(() => new Map<string, Map<string, string>>());
// Models a full storage: writes are dropped without an error, as
// webStringStorage does on a quota failure.
const quota = vi.hoisted(() => ({ full: false }));

vi.mock('react-native-mmkv', () => ({
  MMKV: class {
    private readonly values: Map<string, string>;

    constructor({ id }: { id: string }) {
      this.values = stores.get(id) ?? new Map<string, string>();
      stores.set(id, this.values);
    }

    getString(key: string) {
      return this.values.get(key);
    }

    set(key: string, value: string) {
      if (quota.full) return;
      this.values.set(key, value);
    }

    delete(key: string) {
      this.values.delete(key);
    }

    getAllKeys() {
      return [...this.values.keys()];
    }
  },
}));

import type { NostrEvent } from '@beeline/nostr';
import type { RoomViewMessage, SignedOutboxRecord } from '@beeline/buzz-client';
import { createRoomOutbox } from './surface-storage';

const VIEWER = 'a'.repeat(64);
const ROOM = 'room-1';
const event: NostrEvent = {
  id: '01'.repeat(32),
  pubkey: VIEWER,
  created_at: 10,
  kind: 9,
  tags: [['h', ROOM], ['monolith-attachments', '[]'], ['monolith-mentions', '[]']],
  content: 'unsent before the upgrade',
  sig: '',
};
const row: RoomViewMessage = {
  id: event.id,
  text: event.content,
  createdAt: event.created_at,
  author: { pubkey: VIEWER, kind: 'human', name: 'You' },
  presentation: 'message',
};

describe('relay-scoped Room outbox', () => {
  it('moves an unscoped unsent message to the relay that opens its Room, once', async () => {
    const outboxStore = stores.get('buzz-surface-outbox')!;
    const legacy: SignedOutboxRecord[] = [
      { event, row, status: 'failed', attempts: 2 },
    ];
    outboxStore.set(`outbox.${VIEWER}.${ROOM}`, JSON.stringify(legacy));

    const first = createRoomOutbox('https://relay-one.example/path', { publicKey: VIEWER }, ROOM);
    await first.restore();
    expect(first.list().map((record) => record.event.id)).toEqual([event.id]);
    expect([...outboxStore.keys()]).toEqual([
      `outbox.${encodeURIComponent('https://relay-one.example')}.${VIEWER}.${ROOM}`,
    ]);

    const other = createRoomOutbox('https://relay-two.example', { publicKey: VIEWER }, ROOM);
    await other.restore();
    expect(other.list()).toEqual([]);

    const again = createRoomOutbox('https://relay-one.example', { publicKey: VIEWER }, ROOM);
    await again.restore();
    expect(again.list().map((record) => record.event.id)).toEqual([event.id]);
  });

  it('keeps the unscoped copy when the scoped write is dropped', async () => {
    const outboxStore = stores.get('buzz-surface-outbox')!;
    outboxStore.clear();
    const legacyKey = `outbox.${VIEWER}.${ROOM}`;
    const legacy: SignedOutboxRecord[] = [{ event, row, status: 'failed', attempts: 2 }];
    outboxStore.set(legacyKey, JSON.stringify(legacy));

    quota.full = true;
    try {
      const full = createRoomOutbox('https://relay-one.example', { publicKey: VIEWER }, ROOM);
      await full.restore();
      expect(full.list().map((record) => record.event.id)).toEqual([event.id]);
      expect([...outboxStore.keys()]).toEqual([legacyKey]);
    } finally {
      quota.full = false;
    }

    const reopened = createRoomOutbox('https://relay-one.example', { publicKey: VIEWER }, ROOM);
    await reopened.restore();
    expect(reopened.list().map((record) => record.event.id)).toEqual([event.id]);
    expect([...outboxStore.keys()]).toEqual([
      `outbox.${encodeURIComponent('https://relay-one.example')}.${VIEWER}.${ROOM}`,
    ]);
  });
});
