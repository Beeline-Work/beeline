import { describe, expect, it } from 'vitest';
import type { ChatListItem, ChatListView, RoomViewMessage } from '@beeline/buzz-client';
import {
  applyChatListDelta,
  chatListDeltaNeedsRead,
  chatWatchFiltersKey,
  keepUnavailableChatFacts,
  roomsMissedByLive,
  withCornerFacts,
  withoutCornerFacts,
} from './chat-list-delta';

const agent = { pubkey: 'agent', kind: 'agent' as const, name: 'Greeter' };
const viewer = { pubkey: 'viewer', kind: 'human' as const, name: 'Captain' };

function item(id: string, latestAt: number, extra: Partial<ChatListItem> = {}): ChatListItem {
  return {
    room: { id, workspaceId: 'workspace', name: id, archived: false, createdAt: 1, updatedAt: 1 },
    latestMessage: { id: `${id}-latest`, text: 'earlier', createdAt: latestAt, author: agent },
    unread: false,
    ...extra,
  };
}

function deck(...chats: ChatListItem[]): ChatListView {
  return {
    workspace: { id: 'workspace', name: 'Work', role: 'member', updatedAt: 1 },
    chats,
    viewer,
    truncated: false,
    watchFilters: [],
  };
}

function message(id: string, createdAt: number, extra: Partial<RoomViewMessage> = {}) {
  return {
    id,
    text: `text ${id}`,
    createdAt,
    author: agent,
    presentation: 'message' as const,
    ...extra,
  };
}

describe('chat list deltas', () => {
  it('applies a parent corner status without a deck read, ordered by the corner store', () => {
    const view = deck(item('a', 20), item('b', 10, { agentState: 'working' }));
    const openCorners = [{ id: 'corner', name: 'Fix', state: 'waiting' as const,
      mine: true as const, waitingSince: 30 }];
    const delta = { type: 'corner-status' as const, roomId: 'b',
      cornerCount: 1, waitingCornerCount: 1, openCorners,
      agentState: 'needs-you' as const };
    expect(chatListDeltaNeedsRead(view, delta)).toBe(false);
    // The corner store holds the frame's summary before the list folds it.
    const next = applyChatListDelta(view, delta, {
      openCorners: (roomId) => (roomId === 'b' ? openCorners : undefined),
    });
    expect(next.chats.map((chat) => chat.room.id)).toEqual(['b', 'a']);
    expect(next.chats[0]).toMatchObject({ agentState: 'needs-you' });
    expect(next.chats[0]).not.toHaveProperty('openCorners');
    expect(next.chats[0]).not.toHaveProperty('cornerCount');
  });

  it('keeps corner facts only on the saved copy', () => {
    const facts = { cornerCount: 1, waitingCornerCount: 0, mineCornerCount: 1,
      openCorners: [{ id: 'corner', name: 'Fix', state: 'working' as const, mine: true as const }] };
    const read = deck(item('a', 20, facts), item('b', 10));
    const held = withoutCornerFacts(read);
    expect(held.chats.map((chat) => 'cornerCount' in chat || 'openCorners' in chat))
      .toEqual([false, false]);
    expect(withoutCornerFacts(held)).toBe(held);
    const saved = withCornerFacts(held, (roomId) => (roomId === 'a'
      ? { cornerCount: 1, openCorners: facts.openCorners } : undefined));
    expect(saved.chats[0]).toMatchObject({ cornerCount: 1, openCorners: facts.openCorners });
    expect(saved.chats[1]).not.toHaveProperty('cornerCount');
  });

  it('keeps the approval actor a live update names', () => {
    const view = deck(item('b', 10, {
      agentState: 'needs-you', attentionReason: { kind: 'approval', actor: 'Bot' },
    }));
    const status = applyChatListDelta(view, { type: 'corner-status', roomId: 'b',
      cornerCount: 2, waitingCornerCount: 0, mineCornerCount: 1, openCorners: [],
      agentState: 'needs-you', attentionReason: { kind: 'approval', actor: 'Bot' } });
    expect(status.chats[0]).toMatchObject({
      attentionReason: { kind: 'approval', actor: 'Bot' } });
    const turn = applyChatListDelta(view, { type: 'turn-delta', roomId: 'b',
      turn: { status: 'complete' } as never,
      agentState: 'needs-you', attentionReason: { kind: 'approval', actor: 'Bot' } });
    expect(turn.chats[0]?.attentionReason).toEqual({ kind: 'approval', actor: 'Bot' });
  });

  it('moves an incoming message to the top as the unread preview', () => {
    const view = deck(item('a', 20), item('b', 10));
    const next = applyChatListDelta(view, {
      type: 'message-delta',
      roomId: 'b',
      message: message('new', 30),
    });

    expect(next.chats.map((chat) => chat.room.id)).toEqual(['b', 'a']);
    expect(next.chats[0]).toMatchObject({
      unread: true,
      latestMessage: { id: 'new', text: 'text new', createdAt: 30, author: agent },
    });
  });

  it('reopens a closed chat on newer incoming activity, but not on the viewer’s own', () => {
    const view = deck(item('dm', 10, { closed: true }));
    const incoming = applyChatListDelta(view, {
      type: 'message-delta',
      roomId: 'dm',
      message: message('in', 20),
    });
    expect(incoming.chats[0]!.closed).toBeUndefined();

    const own = applyChatListDelta(view, {
      type: 'message-delta',
      roomId: 'dm',
      message: message('out', 20, { author: viewer }),
    });
    expect(own.chats[0]).toMatchObject({ closed: true, unread: false });
  });

  it('keeps held unread for the viewer’s own message, which another device may have sent', () => {
    // An older agent message is still past the read cursor.
    const view = deck(item('a', 10, { unread: true }));
    const next = applyChatListDelta(view, {
      type: 'message-delta',
      roomId: 'a',
      message: message('mine', 20, { author: viewer }),
    });
    expect(next.chats[0]).toMatchObject({ unread: true, latestMessage: { id: 'mine' } });
  });

  it('does not light unread for a Room the reader has on screen', () => {
    const view = deck(item('a', 20), item('b', 10));
    const viewing = (roomId: string) => roomId === 'b';
    const onScreen = applyChatListDelta(view, {
      type: 'message-delta', roomId: 'b', message: message('seen', 30),
    }, { viewing });
    expect(onScreen.chats[0]).toMatchObject({ room: { id: 'b' }, unread: false,
      latestMessage: { id: 'seen' } });

    const offScreen = applyChatListDelta(view, {
      type: 'message-delta', roomId: 'a', message: message('away', 30),
    }, { viewing });
    expect(offScreen.chats[0]).toMatchObject({ room: { id: 'a' }, unread: true });
  });

  it('ignores older rows, activity rows, and unknown Rooms', () => {
    const view = deck(item('a', 20));
    for (const delta of [
      { type: 'message-delta' as const, roomId: 'a', message: message('old', 5) },
      {
        type: 'message-delta' as const,
        roomId: 'a',
        message: message('tool', 30, { presentation: 'activity' }),
      },
      { type: 'message-delta' as const, roomId: 'elsewhere', message: message('x', 30) },
    ])
      expect(applyChatListDelta(view, delta)).toBe(view);
  });

  it('uses the message id to order deltas within the same second', () => {
    const view = deck(item('a', 20, { latestMessage: {
      id: 'b', text: 'current', createdAt: 20, author: agent,
    } }));
    expect(applyChatListDelta(view, { type: 'message-delta', roomId: 'a',
      message: message('a', 20) })).toBe(view);
    expect(applyChatListDelta(view, { type: 'message-delta', roomId: 'a',
      message: message('c', 20) }).chats[0]?.latestMessage?.id).toBe('c');
  });

  it('updates the same latest row in place without relighting unread', () => {
    const view = deck(item('a', 20), item('b', 10));
    const next = applyChatListDelta(view, {
      type: 'message-delta',
      roomId: 'b',
      message: message('b-latest', 10, { text: 'edited' }),
    });
    expect(next.chats.map((chat) => chat.room.id)).toEqual(['a', 'b']);
    expect(next.chats[1]).toMatchObject({ unread: false, latestMessage: { text: 'edited' } });
  });

  it('reconciles a deleted latest row instead of painting its tombstone or relighting unread', () => {
    const view = deck(item('a', 20, { unread: true }));
    const delta = { type: 'message-delta' as const, roomId: 'a',
      message: message('a-latest', 20, { deleted: true, text: '', presentation: 'system' }) };
    expect(chatListDeltaNeedsRead(view, delta)).toBe(true);
    expect(applyChatListDelta(view, delta)).toBe(view);
    const reconciled = deck(item('a', 10, { unread: false, latestMessage: {
      id: 'previous', text: 'earlier', createdAt: 10, author: agent,
    } }));
    expect(reconciled.chats[0]?.latestMessage?.text).toBe('earlier');
    expect(chatListDeltaNeedsRead(reconciled, delta)).toBe(false);
    const projected = { ...delta, deckPreview: reconciled.chats[0]!.latestMessage! };
    expect(chatListDeltaNeedsRead(view, projected)).toBe(false);
    expect(applyChatListDelta(view, projected).chats[0]?.latestMessage?.id).toBe('previous');
  });

  it('lights a working turn and clears it from the server rollup', () => {
    const view = deck(item('a', 20));
    const working = {
      type: 'turn-delta' as const,
      roomId: 'a',
      turn: { requestId: 'r', agentPubkey: 'agent', status: 'working' as const, createdAt: 30 },
    };
    const lit = applyChatListDelta(view, working);
    expect(lit.chats[0]!.agentState).toBe('working');
    expect(chatListDeltaNeedsRead(view, working)).toBe(false);

    const complete = { ...working, turn: { ...working.turn, status: 'complete' as const },
      agentState: null };
    expect(applyChatListDelta(lit, complete).chats[0]?.agentState).toBeUndefined();
    expect(chatListDeltaNeedsRead(lit, complete)).toBe(false);
    expect(chatListDeltaNeedsRead(view, complete)).toBe(false);

    const needsYou = deck(item('a', 20, { agentState: 'needs-you' }));
    expect(applyChatListDelta(needsYou, working)).toBe(needsYou);
  });

  it('names only Rooms whose newer read row the socket never announced', () => {
    const held = deck(item('a', 20), item('b', 10));
    const read = deck(item('a', 40), item('b', 30), item('fresh', 50));

    expect(roomsMissedByLive(held, read, new Set(['a']))).toEqual(['b']);
    expect(roomsMissedByLive(held, held, new Set())).toEqual([]);
  });

  it('names a Room whose read shows a different latest message in the same second', () => {
    const held = deck(item('a', 20));
    const sameSecond = item('a', 20);
    const read = deck({ ...sameSecond, latestMessage: { ...sameSecond.latestMessage!, id: 'a-other' } });

    expect(roomsMissedByLive(held, read, new Set())).toEqual(['a']);
    expect(roomsMissedByLive(held, read, new Set(['a']))).toEqual([]);
  });
});

describe('keepUnavailableChatFacts', () => {
  const held = deck(
    item('room-a', 10, {
      unread: true,
      cornerCount: 1,
      waitingCornerCount: 1,
      openCorners: [{ id: 'corner-a', name: 'fix', state: 'waiting' }],
    }),
  );

  it('returns a complete read unchanged', () => {
    const read = deck(item('room-a', 10));
    expect(keepUnavailableChatFacts(held, read)).toBe(read);
  });

  it('carries only the facts the server could not read', () => {
    const read = { ...deck(item('room-a', 12, { cornerCount: 0 })), unavailable: ['unread' as const] };
    const kept = keepUnavailableChatFacts(held, read);
    expect(kept.chats[0]).toMatchObject({ unread: true, cornerCount: 0 });
    expect(kept.chats[0]?.latestMessage?.createdAt).toBe(12);
    expect('unavailable' in kept).toBe(false);
  });

  it('shows no dot for a Room it never held and keeps that fact unknown', () => {
    const read = { ...deck(item('room-b', 5)), unavailable: ['unread' as const, 'corners' as const] };
    const kept = keepUnavailableChatFacts(held, read);
    const { unread: _unread, ...unknown } = item('room-b', 5);
    expect(kept.chats[0]).toEqual(unknown);
    expect(kept.unavailable).toEqual(['unread']);
  });

  it('keeps the held value when a row omits unread', () => {
    const { unread: _unread, ...omitted } = item('room-a', 12);
    const kept = keepUnavailableChatFacts(held, deck(omitted));
    expect(kept.chats[0]?.unread).toBe(true);
    expect('unavailable' in kept).toBe(false);
  });

  it('keeps a Room unknown across a second incomplete read', () => {
    const read = { ...deck(item('room-b', 5)), unavailable: ['unread' as const, 'corners' as const] };
    const first = keepUnavailableChatFacts(held, read);
    const second = keepUnavailableChatFacts(first, { ...read, chats: [item('room-b', 6)] });
    expect('unread' in second.chats[0]!).toBe(false);
    expect(second.unavailable).toEqual(['unread']);
  });

  it('keeps a cold read with no held copy unknown, then takes the next complete read', () => {
    const cold = keepUnavailableChatFacts(null, {
      ...deck(item('room-a', 10)), unavailable: ['unread' as const],
    });
    expect('unread' in cold.chats[0]!).toBe(false);
    expect(cold.unavailable).toEqual(['unread']);
    const complete = deck(item('room-a', 10, { unread: true }));
    expect(keepUnavailableChatFacts(cold, complete)).toBe(complete);
  });
});

describe('chatWatchFiltersKey', () => {
  it('ignores Room order but not Room membership', () => {
    const key = chatWatchFiltersKey([{ kinds: [9, 9000], '#h': ['room-a', 'room-b'] }]);
    expect(chatWatchFiltersKey([{ '#h': ['room-b', 'room-a'], kinds: [9000, 9] }])).toBe(key);
    expect(chatWatchFiltersKey([{ kinds: [9, 9000], '#h': ['room-a', 'room-c'] }])).not.toBe(key);
  });
});
