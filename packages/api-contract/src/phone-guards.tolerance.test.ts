import { describe, expect, it } from 'vitest';
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

/** Last night's all-or-nothing Room check: one missing or unexpected field blanks the Room. */
function legacyStrictRoomView(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  const room = item.room as { id?: unknown } | undefined;
  return Boolean(
    room &&
    typeof room.id === 'string' &&
    Array.isArray(item.messages) &&
    item.messages.every(
      (entry) =>
        entry &&
        typeof entry === 'object' &&
        typeof (entry as { presentation?: unknown }).presentation === 'string' &&
        ['message', 'system', 'activity', 'card'].includes(
          String((entry as { presentation?: unknown }).presentation),
        ),
    ) &&
    Array.isArray(item.corners) &&
    Array.isArray(item.members) &&
    Array.isArray(item.latestAgentTurns) &&
    item.viewer &&
    typeof item.repositoryResolution === 'string' &&
    Array.isArray(item.watchFilters),
  );
}

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
      peopleTotal: 21,
      agentTotal: 0,
      membersTruncated: true,
      agentsTruncated: false,
    },
    optionals: ['peopleTotal', 'agentTotal', 'membersTruncated', 'agentsTruncated'],
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
    loadBearingMissing: { agent: { identity: agent, role: 'member' }, catalog: [] },
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
        expect(entry.read({ ...entry.base, unexpectedServerField: { nested: true } })).not.toBeNull();
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
      messages: [message, { id: 'not-a-message' }, { ...message, id: 'd'.repeat(64), text: 'kept' }],
    });
    expect(view?.messages.map((row) => row.text)).toEqual(['Change course', 'kept']);
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
    expect(legacyStrictRoomView(legacyServerRoom)).toBe(true);
    expect(legacyStrictRoomView(currentRoom)).toBe(false);
  });

  it('renders a future Room that an older all-or-nothing check would blank', () => {
    const view = readRoomView(futureServerRoom);
    expect(view?.room.id).toBe(roomId);
    expect(view?.messages).toHaveLength(1);
    expect(legacyStrictRoomView(futureServerRoom)).toBe(false);
  });

  it('renders the older server shape after this bundle and the newer shape before a later server change', () => {
    expect(readRoomView(legacyServerRoom)?.messages).toEqual([]);
    expect(readRoomView(futureServerRoom)?.messages[0]?.text).toBe('Change course');
    expect(legacyStrictRoomView(legacyServerRoom)).toBe(true);
    expect(legacyStrictRoomView(futureServerRoom)).toBe(false);
  });
});
