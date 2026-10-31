vi.mock('@/buzz/room-transition-work', () => ({
  deferRoomWrite: (_key: string, work: () => Promise<void>) => work(),
}));
import { beforeEach, describe, expect, it, vi } from 'vitest';

const stores = vi.hoisted(() => new Map<string, Map<string, string>>());

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
import { resetMessageOutboxes, createRoomOutbox } from './surface-storage';

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
  beforeEach(() => { resetMessageOutboxes(); stores.get('buzz-surface-outbox')!.clear(); });
  it('keeps an unsent message with the relay it was saved for', async () => {
    const outboxStore = stores.get('buzz-surface-outbox')!;
    const first = createRoomOutbox('https://relay-one.example/path', { publicKey: VIEWER }, ROOM);
    await first.restore();
    await first.enqueue(event, row);
    expect([...outboxStore.keys()]).toEqual([
      `outbox.${encodeURIComponent('https://relay-one.example')}.${VIEWER}.app`,
    ]);

    const other = createRoomOutbox('https://relay-two.example', { publicKey: VIEWER }, ROOM);
    await other.restore();
    expect(other.list()).toEqual([]);

    const again = createRoomOutbox('https://relay-one.example', { publicKey: VIEWER }, ROOM);
    await again.restore();
    expect(again.list().map((record) => record.event.id)).toEqual([event.id]);
  });

  it('migrates every scoped Room key into one owner and removes the old writers', async () => {
    const disk = stores.get('buzz-surface-outbox')!;
    const oldKey = `outbox.${encodeURIComponent('https://relay-one.example')}.${VIEWER}.${ROOM}`;
    disk.set(oldKey, JSON.stringify([{ event, row, status: 'failed', attempts: 4 }]));
    const first = createRoomOutbox('https://relay-one.example', { publicKey: VIEWER }, ROOM);
    const same = createRoomOutbox('https://relay-one.example', { publicKey: VIEWER }, ROOM);
    expect(first).toBe(same);
    await first.restore();
    expect(first.list()[0]?.status).toBe('pending');
    expect(disk.has(oldKey)).toBe(false);
    resetMessageOutboxes();
    const restored = createRoomOutbox('https://relay-one.example', { publicKey: VIEWER }, ROOM);
    await restored.restore();
    expect(restored.list().map(record => record.event.id)).toEqual([event.id]);
  });

  it('does not read an outbox saved before relay scoping', async () => {
    const outboxStore = stores.get('buzz-surface-outbox')!;
    outboxStore.clear();
    const legacy: SignedOutboxRecord[] = [{ event, row, status: 'failed', attempts: 2 }];
    outboxStore.set(`outbox.${VIEWER}.app`, JSON.stringify(legacy));
    const outbox = createRoomOutbox('https://relay-one.example', { publicKey: VIEWER }, ROOM);
    await outbox.restore();
    expect(outbox.list()).toEqual([]);
  });
});
