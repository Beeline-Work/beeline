import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  readRoomHistoryView,
  readRoomView,
  type RoomView,
  type RoomViewMessage,
} from '@beeline/api-contract/phone';
import { compactRoomHistoryView, compactRoomView, wantsCompactView } from './compact-room-view.js';

const ROOM = '22222222-2222-4222-8222-222222222222';
const hex = (seed: string) => seed.repeat(64).slice(0, 64);
const author = { pubkey: hex('a'), kind: 'agent' as const, name: 'Otter', handle: 'otter' };

function message(id: string, at: number, extra: Partial<RoomViewMessage> = {}): RoomViewMessage {
  return {
    id,
    text: `message ${id.slice(0, 4)}`,
    createdAt: Math.floor(at / 1000),
    createdAtMs: at,
    author,
    presentation: 'message',
    reference: { channelId: ROOM, eventId: id, rootId: id },
    ...extra,
  };
}

const view: RoomView = {
  room: {
    id: ROOM,
    workspaceId: '11111111-1111-4111-8111-111111111111',
    name: 'general',
    archived: false,
    createdAt: 1,
    updatedAt: 2,
  },
  messages: [
    message(hex('1'), 1_791_000_000_123),
    // A reply's reference names its thread root: it stays.
    message(hex('2'), 1_791_000_001_456, {
      reference: { channelId: ROOM, eventId: hex('2'), rootId: hex('1') },
      reply: { channelId: ROOM, eventId: hex('1'), rootId: hex('1') },
    }),
    // A deleted message reads as a system line yet keeps its reference.
    message(hex('3'), 1_791_000_002_789, { presentation: 'system', deleted: true }),
    // A card has no reference at all.
    { ...message(hex('4'), 1_791_000_003_000, { presentation: 'card' }), reference: undefined },
  ].map((item) => JSON.parse(JSON.stringify(item)) as RoomViewMessage),
  toolRows: [message(hex('5'), 1_791_000_004_000, { presentation: 'activity', reference: undefined })],
  members: [{ identity: author, role: 'member' }],
  latestAgentTurns: [],
  viewer: {
    identity: { pubkey: hex('b'), kind: 'human', name: 'Captain' },
    role: 'owner',
    permissions: { send: true, manage: true },
  },
  repositoryResolution: 'absent',
  watchFilters: [{ kinds: [9], '#h': [ROOM] }],
} as unknown as RoomView;

describe('compact Room reads', () => {
  it('is asked for by one header value only', () => {
    expect(wantsCompactView('compact')).toBe(true);
    expect(wantsCompactView(undefined)).toBe(false);
    expect(wantsCompactView('full')).toBe(false);
  });

  it('reads back to exactly the full read, less the relay-era watch filters', () => {
    const wire = JSON.parse(JSON.stringify(compactRoomView(view)));
    expect(wire.watchFilters).toBeUndefined();
    expect(wire.messages[0]).not.toHaveProperty('reference');
    expect(wire.messages[0]).not.toHaveProperty('createdAt');
    expect(wire.messages[1].reference.rootId).toBe(hex('1'));
    expect(wire.messages[2].reference.eventId).toBe(hex('3'));
    expect(readRoomView(wire)).toEqual({ ...readRoomView(view), watchFilters: [] });
  });

  it('reads a compact history page back to the full page', () => {
    const page = { roomId: ROOM, messages: view.messages };
    const wire = JSON.parse(JSON.stringify(compactRoomHistoryView(page)));
    expect(readRoomHistoryView(wire)).toEqual(readRoomHistoryView(page));
  });

  it('shrinks the compressed Room read', () => {
    const many: RoomView = {
      ...view,
      messages: Array.from({ length: 30 }, (_, index) =>
        message(index.toString(16).padStart(64, '0'), 1_791_000_000_000 + index * 61_234),
      ),
    };
    const full = gzipSync(JSON.stringify(many)).length;
    const compact = gzipSync(JSON.stringify(compactRoomView(many))).length;
    expect(compact).toBeLessThan(full * 0.9);
  });
});
