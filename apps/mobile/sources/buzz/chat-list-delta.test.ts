import { describe, expect, it } from 'vitest';
import type { ChatListItem, ChatListView, RoomViewMessage } from '@beeline/buzz-client';
import {
  applyChatListDelta,
  chatListDeltaNeedsRead,
  roomsMissedByLive,
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

  it('lights a working turn, and asks for a read only when a settled turn meets a working row', () => {
    const view = deck(item('a', 20));
    const working = {
      type: 'turn-delta' as const,
      roomId: 'a',
      turn: { requestId: 'r', agentPubkey: 'agent', status: 'working' as const, createdAt: 30 },
    };
    const lit = applyChatListDelta(view, working);
    expect(lit.chats[0]!.agentState).toBe('working');
    expect(chatListDeltaNeedsRead(view, working)).toBe(false);

    const complete = { ...working, turn: { ...working.turn, status: 'complete' as const } };
    expect(applyChatListDelta(lit, complete)).toBe(lit);
    expect(chatListDeltaNeedsRead(lit, complete)).toBe(true);
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
