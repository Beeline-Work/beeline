import { describe, expect, it, vi } from 'vitest';
import {
  RoomViewClient,
  createIdentity,
  type ChatListItem,
  type ChatListView,
  type RoomView,
  type RoomViewMessage,
} from '@beeline/buzz-client';
import {
  roomListSections,
  roomRowName,
  roomRowNeedsAttention,
  roomRowPreview,
} from './room-list-row';
import { createRoomMessageProjector, reconcileRoomView } from './room-view-presentation';

/**
 * In-process projection microbench only (mocked fetch, JSON clone, pure row/
 * transcript helpers). Not a React Native navigation/layout page-load proof;
 * audit F5 450 ms cold/warm route target remains open.
 */
const CLIENT_PAINT_TARGET_MS = 450;
const DECK_ROOM_COUNT = 200;
const TRANSCRIPT_MESSAGE_COUNT = 30;

const WORKSPACE = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const ROOM = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const VIEWER = 'a'.repeat(64);

vi.mock('react-native-mmkv', () => ({
  MMKV: class {
    getString() {
      return undefined;
    }
    set() {}
    delete() {}
    getAllKeys() {
      return [];
    }
  },
}));

function hexId(seed: number): string {
  return seed.toString(16).padStart(64, '0');
}

function roomId(index: number): string {
  return `cccccccc-3333-4333-8333-${String(index).padStart(12, '0')}`;
}

function chatItem(index: number): ChatListItem {
  const id = roomId(index);
  return {
    room: {
      id,
      workspaceId: WORKSPACE,
      name: `Room ${index}`,
      archived: false,
      createdAt: 1_700_000_000 + index,
      updatedAt: 1_700_000_100 + index,
    },
    latestMessage: {
      id: hexId(10_000 + index),
      text: `hello ${index}`,
      createdAt: 1_700_000_100 + index,
      author: { pubkey: VIEWER, kind: 'human', name: 'Captain', handle: 'captain' },
    },
    memberCount: 2,
    cornerCount: index % 5,
    unread: index % 7 === 0,
    agentState: index % 11 === 0 ? 'working' : undefined,
  };
}

function transcriptMessage(index: number): RoomViewMessage {
  return {
    id: hexId(20_000 + index),
    text: `line ${index} — measured client paint path`,
    createdAt: 1_700_000_200 + index,
    author: {
      pubkey: index % 2 === 0 ? VIEWER : 'b'.repeat(64),
      kind: index % 2 === 0 ? 'human' : 'agent',
      name: index % 2 === 0 ? 'Captain' : 'Helper',
      handle: index % 2 === 0 ? 'captain' : 'helper',
    },
    presentation: 'message',
  };
}

function deckView(): ChatListView {
  const chats = Array.from({ length: DECK_ROOM_COUNT }, (_, i) => chatItem(i));
  return {
    workspace: {
      id: WORKSPACE,
      name: 'Paint Workspace',
      visibility: 'invite-only',
      role: 'owner',
      updatedAt: 1_700_000_000,
    },
    chats,
    viewer: { pubkey: VIEWER, kind: 'human', name: 'Captain', handle: 'captain' },
    truncated: false,
    watchFilters: [{ kinds: [9], '#h': chats.map((chat) => chat.room.id) }],
  };
}

function transcriptView(): RoomView {
  return {
    room: {
      id: ROOM,
      workspaceId: WORKSPACE,
      name: 'Paint Room',
      archived: false,
      createdAt: 1_700_000_000,
      updatedAt: 1_700_000_230,
    },
    messages: Array.from({ length: TRANSCRIPT_MESSAGE_COUNT }, (_, i) => transcriptMessage(i)),
    members: [
      {
        identity: { pubkey: VIEWER, kind: 'human', name: 'Captain', handle: 'captain' },
        role: 'owner',
      },
    ],
    latestAgentTurns: [],
    repositoryResolution: 'none',
    viewer: {
      identity: { pubkey: VIEWER, kind: 'human', name: 'Captain', handle: 'captain' },
      role: 'owner',
      permissions: { send: true, manage: true },
    },
    watchFilters: [{ kinds: [9], '#h': [ROOM] }],
  };
}

/** Simulate the phone's MMKV surface-cache round trip before paint. */
function hydrateFromCache<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function paintDeck(view: ChatListView): number {
  const sections = roomListSections(view.chats);
  let painted = 0;
  for (const section of sections) {
    for (const item of section.data) {
      const heading = roomRowName(item);
      const preview = roomRowPreview(item, view.viewer.pubkey);
      const attention = roomRowNeedsAttention(item);
      painted += heading.name.length + preview.text.length + Number(attention);
    }
  }
  return painted;
}

function paintTranscript(view: RoomView): number {
  const projector = createRoomMessageProjector();
  let current: RoomView | null = null;
  current = reconcileRoomView(current, view);
  const rows = projector.project(current.messages, current.viewer.identity.pubkey);
  return rows.reduce((sum, row) => sum + (row.text?.length ?? 0), 0);
}

/**
 * Monolith client cold/warm Room-deck and transcript paint budgets (audit F5).
 * Exercises RoomViewClient transport + validation, cache hydration,
 * and the same row/transcript projection the phone paints — not in-process
 * PhoneService alone.
 */
describe('monolith client paint projection microbench (not RN page-load)', () => {
  it('in-process direct read and deck/transcript paint stay under 450 ms', async () => {
    const deck = deckView();
    const transcript = transcriptView();
    const identity = createIdentity('monolith-client-paint');
    const physicalFetch = vi.fn(async (url: string) => {
      if (String(url).includes('/chats')) return Response.json(deck);
      if (String(url).includes('/room/')) return Response.json(transcript);
      return new Response('not found', { status: 404 });
    });
    const client = new RoomViewClient({
      baseUrl: 'https://monolith.test',
      identity,
      fetch: physicalFetch as typeof fetch,
    });

    const measure = async (label: string, work: () => Promise<unknown>) => {
      const started = performance.now();
      await work();
      const elapsedMs = performance.now() - started;
      console.log(JSON.stringify({ path: label, elapsedMs: Math.round(elapsedMs * 100) / 100 }));
      return elapsedMs;
    };

    const paintDeckThroughClient = async () => {
      const fetched = await client.chats(WORKSPACE);
      const hydrated = hydrateFromCache(fetched);
      const painted = paintDeck(hydrated);
      expect(painted).toBeGreaterThan(0);
      expect(hydrated.chats.length).toBe(DECK_ROOM_COUNT);
    };

    const paintTranscriptThroughClient = async () => {
      const fetched = await client.room(ROOM);
      const hydrated = hydrateFromCache(fetched);
      const painted = paintTranscript(hydrated);
      expect(painted).toBeGreaterThan(0);
      expect(hydrated.messages.length).toBe(TRANSCRIPT_MESSAGE_COUNT);
    };

    const coldDeck = await measure('client-deck-cold', paintDeckThroughClient);
    const warmDeck = await measure('client-deck-warm', paintDeckThroughClient);
    const coldTranscript = await measure('client-transcript-cold', paintTranscriptThroughClient);
    const warmTranscript = await measure('client-transcript-warm', paintTranscriptThroughClient);

    for (const [label, elapsedMs] of [
      ['cold deck', coldDeck],
      ['warm deck', warmDeck],
      ['cold transcript', coldTranscript],
      ['warm transcript', warmTranscript],
    ] as const) {
      expect(elapsedMs, `${label} exceeded ${CLIENT_PAINT_TARGET_MS} ms`).toBeLessThanOrEqual(
        CLIENT_PAINT_TARGET_MS,
      );
    }
    expect(physicalFetch.mock.calls.length).toBeGreaterThanOrEqual(4);
  });
});
