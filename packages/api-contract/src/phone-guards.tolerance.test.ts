import { describe, expect, it } from 'vitest';
import { ROOM_VIEW_MESSAGE_LIMIT } from './phone-types.js';
import {
  readAgentDetailView,
  readAgentGrantView,
  readAgentPairingAbandonView,
  readAgentPairingClaimView,
  readAgentPairingClaimWireView,
  readChatListView,
  readConnectorOfferCardView,
  readCornerListView,
  readInviteView,
  readRoomHistoryView,
  readRoomView,
  readRoomViewMessage,
  readWorkspaceListView,
  readWorkspaceMemberListView,
  readWorkspaceView,
  type SurfaceReader,
} from './phone-guards.js';

const identity = { pubkey: 'a'.repeat(64), kind: 'human' as const, name: 'Owner' };
const agent = { pubkey: 'c'.repeat(64), kind: 'agent' as const, name: 'Bee' };
const roomId = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const workspaceId = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

const header = {
  id: roomId,
  workspaceId,
  name: 'Launch',
  archived: false,
  createdAt: 1,
  updatedAt: 2,
};

const viewer = { identity, role: 'owner' as const, permissions: { send: true, manage: true } };

const currentRoom = {
  room: header,
  messages: [],
  members: [],
  latestAgentTurns: [],
  repositoryResolution: 'none',
  viewer,
  watchFilters: [],
};

const message = {
  id: 'b'.repeat(64),
  text: 'Change course',
  createdAt: 1,
  author: identity,
  presentation: 'message' as const,
};

const grant = {
  grantId: 'grant-1',
  kind: 'path' as const,
  target: '/tmp',
  reason: 'read logs',
  status: 'approved' as const,
  requestedBy: identity,
  roomId,
  createdAt: 1,
  auto: false,
};

const connectorOffer = {
  offerId: roomId,
  agent,
  addressee: identity,
  connectorType: 'trusty-squire' as const,
  connectorName: 'Trusty Squire',
  reason: 'vault',
  consequence: 'still no raw key in chat',
  helper: { machineId: 'host-1', name: 'rig' },
  status: 'pending' as const,
  createdAt: 1,
};

const workspace = {
  id: workspaceId,
  name: 'Hive',
  visibility: 'invite-only' as const,
  role: 'owner' as const,
  updatedAt: 1,
  createdAt: 1,
};

type Case = {
  name: string;
  read: SurfaceReader<unknown>;
  base: Record<string, unknown>;
  optionals: readonly string[];
  loadBearingMissing: Record<string, unknown>;
};

const cases: Case[] = [
  {
    name: 'RoomView',
    read: readRoomView,
    base: currentRoom,
    optionals: [
      'toolRows',
      'directMessage',
      'parent',
      'briefing',
      'cornerPlan',
      'repository',
      'cornerLifecycle',
      'members',
      'latestAgentTurns',
      'viewer',
      'repositoryResolution',
      'watchFilters',
    ],
    loadBearingMissing: { messages: currentRoom.messages, viewer },
  },
  {
    name: 'RoomViewMessage',
    read: readRoomViewMessage,
    base: message,
    optionals: [
      'createdAtMs',
      'bookmarked',
      'reference',
      'reply',
      'liveTurnId',
      'requestId',
      'agentModel',
      'attachments',
      'mentionPubkeys',
      'reactions',
      'activity',
      'durableFact',
      'corner',
      'permission',
      'grantRequest',
      'connectorOffer',
      'choice',
      'walletTx',
      'walletInsufficient',
      'walletDelegation',
      'targetBranch',
      'githubEvent',
      'relay',
      'daemonFact',
      'systemEvent',
      'presentation',
      'text',
    ],
    loadBearingMissing: { text: 'x', createdAt: 1, author: identity, presentation: 'message' },
  },
  {
    name: 'RoomHistoryView',
    read: readRoomHistoryView,
    base: { roomId, messages: [] },
    optionals: ['nextBefore'],
    loadBearingMissing: { messages: [] },
  },
  {
    name: 'WorkspaceListView',
    read: readWorkspaceListView,
    base: { workspaces: [], viewer: identity, truncated: false, watchFilters: [] },
    optionals: ['truncated', 'watchFilters', 'deletedNotices'],
    loadBearingMissing: { viewer: identity, truncated: false, watchFilters: [] },
  },
  {
    name: 'WorkspaceView',
    read: readWorkspaceView,
    base: {
      workspace,
      members: [],
      agents: [],
      peopleTotal: 21,
      agentTotal: 0,
      membersTruncated: true,
      agentsTruncated: false,
      viewer,
      watchFilters: [],
    },
    optionals: [
      'managerSettings',
      'peopleTotal',
      'agentTotal',
      'members',
      'agents',
      'membersTruncated',
      'agentsTruncated',
      'viewer',
      'watchFilters',
    ],
    loadBearingMissing: { members: [], agents: [], viewer, watchFilters: [] },
  },
  {
    name: 'WorkspaceMemberListView',
    read: readWorkspaceMemberListView,
    base: {
      members: [],
      agents: [],
      grants: [{ ...grant, agent }],
      peopleTotal: 21,
      agentTotal: 0,
      membersTruncated: true,
      agentsTruncated: false,
    },
    optionals: ['peopleTotal', 'agentTotal', 'grants', 'membersTruncated', 'agentsTruncated'],
    loadBearingMissing: { agents: [], membersTruncated: true, agentsTruncated: false },
  },
  {
    name: 'ChatListView',
    read: readChatListView,
    base: { workspace, chats: [], viewer: identity, truncated: false, watchFilters: [] },
    optionals: ['truncated', 'watchFilters'],
    loadBearingMissing: { chats: [], viewer: identity, truncated: false, watchFilters: [] },
  },
  {
    name: 'CornerListView',
    read: readCornerListView,
    base: { room: header, corners: [], viewer, watchFilters: [] },
    optionals: ['viewer', 'watchFilters'],
    loadBearingMissing: { corners: [], viewer, watchFilters: [] },
  },
  {
    name: 'AgentDetailView',
    read: readAgentDetailView,
    base: {
      workspaceId,
      agent: { identity: agent, role: 'member' },
      catalog: [],
      commands: [],
      watchFilters: [],
    },
    optionals: [
      'owner',
      'soul',
      'seededSoul',
      'runtimeSelection',
      'selected',
      'modelUnavailable',
      'yolo',
      'access',
      'grants',
      'canManageGrants',
      'watchFilters',
    ],
    loadBearingMissing: { agent: { identity: agent, role: 'member' }, catalog: [], commands: [] },
  },
  {
    name: 'InviteView',
    read: readInviteView,
    base: { name: 'Builders', expiresAt: 2_000_000_000 },
    optionals: ['avatar', 'joinedWorkspaceId'],
    loadBearingMissing: { expiresAt: 2_000_000_000 },
  },
  {
    name: 'AgentPairingClaimWireView',
    read: readAgentPairingClaimWireView,
    base: { workspaceId, pairedBy: identity.pubkey, joined: true },
    optionals: ['attachedRoomIds'],
    loadBearingMissing: { pairedBy: identity.pubkey, joined: true },
  },
  {
    name: 'AgentPairingClaimView',
    read: readAgentPairingClaimView,
    base: { workspaceId, pairedBy: identity.pubkey, joined: true, attachedRoomIds: [] },
    optionals: ['attachedRoomIds'],
    loadBearingMissing: { pairedBy: identity.pubkey, joined: true },
  },
  {
    name: 'AgentPairingAbandonView',
    read: readAgentPairingAbandonView,
    base: { abandoned: true },
    optionals: [],
    loadBearingMissing: {},
  },
  {
    name: 'AgentGrantView',
    read: readAgentGrantView,
    base: grant,
    optionals: ['decidedBy', 'decidedAt', 'expiresAt', 'script'],
    loadBearingMissing: { ...grant, grantId: undefined },
  },
  {
    name: 'ConnectorOfferCardView',
    read: readConnectorOfferCardView,
    base: connectorOffer,
    optionals: ['acceptedBy', 'acceptedAt', 'connectorId'],
    loadBearingMissing: { ...connectorOffer, offerId: undefined },
  },
];

describe('phone surface readers', () => {
  for (const entry of cases) {
    describe(entry.name, () => {
      it('keeps the view when an unknown field arrives', () => {
        expect(
          entry.read({ ...entry.base, unexpectedServerField: { nested: true } }),
        ).not.toBeNull();
      });

      for (const optional of entry.optionals) {
        it(`keeps the view when ${optional} is absent`, () => {
          const { [optional]: _omitted, ...rest } = entry.base;
          expect(entry.read(rest)).not.toBeNull();
        });
      }

      it('fails only when load-bearing identity is missing', () => {
        expect(entry.read(entry.loadBearingMissing)).toBeNull();
      });
    });
  }

  it('drops an unreadable list entry instead of blanking the Room', () => {
    const view = readRoomView({
      ...currentRoom,
      messages: [
        message,
        { id: 'not-a-message' },
        { ...message, id: 'd'.repeat(64), text: 'kept' },
      ],
    });
    expect(view?.messages.map((row) => row.text)).toEqual(['Change course', 'kept']);
  });

  it('keeps valid read-cursor counts and drops malformed turn counts', () => {
    const cursor = { messageId: null, firstUnreadMessageId: 'b'.repeat(64), unreadCount: 15 };
    expect(
      readRoomView({
        ...currentRoom,
        viewer: { ...viewer, readCursor: { ...cursor, unreadAgentTurnCount: 6 } },
      })?.viewer.readCursor?.unreadAgentTurnCount,
    ).toBe(6);
    expect(
      readRoomView({
        ...currentRoom,
        viewer: { ...viewer, readCursor: { ...cursor, unreadAgentTurnCount: -1 } },
      })?.viewer.readCursor?.unreadAgentTurnCount,
    ).toBeUndefined();
  });

  it('preserves a Squire request source link through the Room message reader', () => {
    const sourceMessageId = 'd'.repeat(64);
    const grantRequest = {
      agent,
      owner: identity,
      requester: identity,
      grants: [grant],
      sourceRoomId: roomId,
      sourceMessageId,
    };
    const view = readRoomView({
      ...currentRoom,
      messages: [{ ...message, grantRequest }],
    });
    expect(view?.messages[0]?.grantRequest).toMatchObject({
      sourceRoomId: roomId,
      sourceMessageId,
    });

    const invalid = readRoomViewMessage({
      ...message,
      grantRequest: { ...grantRequest, sourceMessageId: 'not-a-message-id' },
    });
    expect(invalid?.grantRequest).toBeDefined();
    expect(invalid?.grantRequest?.sourceRoomId).toBeUndefined();
    expect(invalid?.grantRequest?.sourceMessageId).toBeUndefined();
  });

  it('preserves a Squire-owned approval link and drops malformed destinations', () => {
    const sourceMessageId = 'e'.repeat(64);
    const squireApproval = {
      agent,
      tool: 'inject_card',
      title: 'Purchase approval',
      detail: 'Headphones · at Acme · 199.00 USD',
      approvalUrl: 'https://approve.trustysquire.test/approval/one',
      approvalId: 'one',
      linkKind: 'approval' as const,
      sourceRoomId: roomId,
      sourceMessageId,
    };
    expect(readRoomViewMessage({ ...message, squireApproval })?.squireApproval).toEqual(
      squireApproval,
    );
    expect(
      readRoomViewMessage({
        ...message,
        squireApproval: { ...squireApproval, approvalUrl: 'javascript:alert(1)' },
      })?.squireApproval,
    ).toBeUndefined();
  });

  it('keeps a native installed Corner App without a linked developer identity', () => {
    const app = {
      version: 1,
      slug: 'release-board',
      title: 'Release board',
      command: 'release-board',
      blocks: [{ type: 'text', text: 'Ready to release.' }],
      authorName: 'Bee Labs',
      revision: 1,
      updatedAt: 2,
    };
    expect(readRoomView({ ...currentRoom, cornerApps: [app] })?.cornerApps).toEqual([app]);
  });

  it('keeps the deck when the Workspace names a role or visibility this bundle does not know', () => {
    const view = readChatListView({
      workspace: { ...workspace, visibility: 'unlisted', role: 'steward' },
      chats: [],
      viewer: identity,
      truncated: false,
      watchFilters: [],
    });
    expect(view?.workspace.id).toBe(workspaceId);
    expect(view?.workspace.visibility).toBeUndefined();
    expect(view?.workspace.role).toBe('member');
  });

  it('keeps a deck row whose counts the server stopped sending, as unknown rather than zero', () => {
    const view = readChatListView({
      workspace,
      chats: [{ room: header }],
      viewer: identity,
      truncated: false,
      watchFilters: [],
    });
    expect(view?.chats).toHaveLength(1);
    expect(view?.chats[0]?.memberCount).toBeUndefined();
    expect(view?.chats[0]?.cornerCount).toBeUndefined();
    expect(view?.chats[0]?.unread).toBe(false);
  });

  it('reads open corners and drops rows it cannot render', () => {
    const cornerId = '44444444-4444-4444-8444-444444444444';
    const view = readChatListView({
      workspace,
      chats: [
        {
          room: header,
          openCorners: [
            { id: cornerId, name: 'Open corner', state: 'waiting' },
            { id: cornerId, name: 'Mine', state: 'review', mine: true },
            { id: cornerId, name: 'Not a flag', state: 'working', mine: 'yes' },
            { id: cornerId, name: 'Closed corner', state: 'archived' },
            { id: 'not-a-uuid', name: 'Bad id', state: 'working' },
          ],
        },
      ],
      viewer: identity,
      truncated: false,
      watchFilters: [],
    });
    expect(view?.chats[0]?.openCorners).toEqual([
      { id: cornerId, name: 'Open corner', state: 'waiting' },
      { id: cornerId, name: 'Mine', state: 'review', mine: true },
      { id: cornerId, name: 'Not a flag', state: 'working' },
    ]);
  });

  it('preserves valid waiting counts without inventing them for older servers', () => {
    for (const count of [undefined, -1, '2', 2, 0]) {
      const view = readChatListView({
        workspace,
        chats: [{ room: header, waitingCornerCount: count }],
        viewer: identity,
        truncated: false,
        watchFilters: [],
      });
      expect(view?.chats[0]?.waitingCornerCount).toBe(
        typeof count === 'number' && count >= 0 ? count : undefined,
      );
    }
  });

  it('drops a watch filter it cannot read whole rather than widening the subscription', () => {
    expect(
      readRoomView({ ...currentRoom, watchFilters: [{ '#h': 'not-an-array' }] })?.watchFilters,
    ).toEqual([]);
    expect(
      readRoomView({
        ...currentRoom,
        watchFilters: [{ kinds: [9], '#h': 'not-an-array' }],
      })?.watchFilters,
    ).toEqual([]);
    expect(
      readRoomView({
        ...currentRoom,
        watchFilters: [{ kinds: [9], '#e': [roomId] }],
      })?.watchFilters,
    ).toEqual([]);
    expect(
      readRoomView({
        ...currentRoom,
        watchFilters: [{ kinds: [9], '#h': [roomId] }],
      })?.watchFilters,
    ).toEqual([{ kinds: [9], '#h': [roomId] }]);
    expect(
      readRoomView({
        ...currentRoom,
        watchFilters: Array.from({ length: 40 }, () => ({ '#h': [roomId] })),
      })?.watchFilters,
    ).toHaveLength(32);
  });

  it('keeps the newest rows when the server sends more messages than this bundle caps', () => {
    const sent = Array.from({ length: ROOM_VIEW_MESSAGE_LIMIT + 10 }, (_, index) => ({
      ...message,
      id: index.toString(16).padStart(64, '0'),
      text: `message ${index}`,
      createdAt: index + 1,
    }));
    const view = readRoomView({ ...currentRoom, messages: sent });
    expect(view?.messages).toHaveLength(ROOM_VIEW_MESSAGE_LIMIT);
    expect(view?.messages.at(-1)?.text).toBe(`message ${sent.length - 1}`);
    expect(view?.messages[0]?.text).toBe(`message ${sent.length - ROOM_VIEW_MESSAGE_LIMIT}`);
  });

  it('omits an unreadable createdAt, updatedAt or archived instead of inventing one', () => {
    const { createdAt: _c, updatedAt: _u, archived: _a, ...bareHeader } = header;
    const view = readRoomView({ ...currentRoom, room: bareHeader });
    expect(view?.room.id).toBe(roomId);
    expect('createdAt' in (view?.room ?? {})).toBe(false);
    expect('updatedAt' in (view?.room ?? {})).toBe(false);
    expect('archived' in (view?.room ?? {})).toBe(false);

    const wrongTypes = readRoomView({
      ...currentRoom,
      room: { ...header, createdAt: 'yesterday', updatedAt: -1, archived: 'no' },
    });
    expect(wrongTypes?.room.createdAt).toBeUndefined();
    expect(wrongTypes?.room.updatedAt).toBeUndefined();
    expect(wrongTypes?.room.archived).toBeUndefined();
    expect(readRoomView({ ...currentRoom, room: header })?.room.updatedAt).toBe(2);
  });

  it('drops a reply anchor that names another Room instead of carrying it through', () => {
    const foreign = 'cccccccc-3333-4333-8333-cccccccccccc';
    const view = readRoomView({
      ...currentRoom,
      messages: [
        {
          ...message,
          reference: { channelId: foreign, eventId: message.id, rootId: 'd'.repeat(64) },
          reply: { channelId: foreign, eventId: 'e'.repeat(64), rootId: 'f'.repeat(64) },
        },
      ],
    });
    expect(view?.messages).toHaveLength(1);
    expect(view?.messages[0]?.reference).toBeUndefined();
    expect(view?.messages[0]?.reply).toBeUndefined();

    const sameRoom = readRoomView({
      ...currentRoom,
      messages: [
        {
          ...message,
          reference: { channelId: roomId, eventId: message.id, rootId: 'd'.repeat(64) },
          reply: { channelId: roomId, eventId: 'e'.repeat(64), rootId: 'f'.repeat(64) },
        },
      ],
    });
    expect(sameRoom?.messages[0]?.reference).toEqual({
      channelId: roomId,
      eventId: message.id,
      rootId: 'd'.repeat(64),
    });
    expect(sameRoom?.messages[0]?.reply).toEqual({
      channelId: roomId,
      eventId: 'e'.repeat(64),
      rootId: 'f'.repeat(64),
    });
  });

  it('reads an unnameable repositoryResolution as unverified, never as no repository', () => {
    expect(
      readRoomView({ ...currentRoom, repositoryResolution: 'scratch' })?.repositoryResolution,
    ).toBe('unverified');
    const { repositoryResolution: _omitted, ...withoutResolution } = currentRoom;
    expect(readRoomView(withoutResolution)?.repositoryResolution).toBe('unverified');
  });

  it('keeps a message when an optional card field is a kind this bundle does not know', () => {
    const view = readRoomView({
      ...currentRoom,
      messages: [
        {
          ...message,
          presentation: 'future-card',
          githubEvent: {
            type: 'release',
            action: 'published',
            actor: 'octocat',
            title: 'v1',
            url: 'https://github.com/acme/repo/releases/1',
          },
        },
      ],
    });
    expect(view?.messages).toHaveLength(1);
    expect(view?.messages[0]?.presentation).toBe('message');
    expect(view?.messages[0]?.githubEvent?.type).toBe('release');
  });
});

describe('Room payload compatibility in both directions', () => {
  const legacyServerRoom = {
    ...currentRoom,
    corners: [],
  };
  const futureServerRoom = {
    room: header,
    messages: [
      {
        ...message,
        presentation: 'notice',
        futureCard: { kind: 'added-tomorrow' },
      },
    ],
    futureTopLevel: 'server-only',
  };

  it('renders a pre-1516 Room (corners present) and a post-1516 Room (corners absent)', () => {
    expect(readRoomView(legacyServerRoom)?.room.id).toBe(roomId);
    expect(readRoomView(currentRoom)?.room.id).toBe(roomId);
  });

  it('renders a future Room that an older all-or-nothing check would blank', () => {
    const view = readRoomView(futureServerRoom);
    expect(view?.room.id).toBe(roomId);
    expect(view?.messages).toHaveLength(1);
  });

  it('renders the older server shape after this bundle and the newer shape before a later server change', () => {
    expect(readRoomView(legacyServerRoom)?.messages).toEqual([]);
    expect(readRoomView(futureServerRoom)?.messages[0]?.text).toBe('Change course');
  });
});

describe('agent profile recent work', () => {
  const profile = {
    workspaceId,
    agent: { identity: agent, role: 'member' },
    catalog: [],
    watchFilters: [],
  };
  it('reads old servers without work and rejects unsafe links without dropping the profile', () => {
    expect(readAgentDetailView(profile)?.recentWork).toEqual([]);
    const work = { title: 'Visible merged work', url: 'https://github.com/acme/repo/pull/12' };
    expect(
      readAgentDetailView({
        ...profile,
        recentWork: [
          work,
          { title: 'Unsafe', url: 'javascript:alert(1)' },
          { title: 'Other host', url: 'https://evil.example/acme/repo/pull/1' },
        ],
      })?.recentWork,
    ).toEqual([work]);
  });
});
