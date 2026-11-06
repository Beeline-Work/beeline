
import { describe as m45_describe, expect as m45_expect, it as m45_it } from 'vitest';


import { ROOM_VIEW_MESSAGE_LIMIT as m45_ROOM_VIEW_MESSAGE_LIMIT } from "./phone-types.js";


import {
  readAgentDetailView as m45_readAgentDetailView,
  readAgentGrantView as m45_readAgentGrantView,
  readAgentPairingAbandonView as m45_readAgentPairingAbandonView,
  readAgentPairingClaimView as m45_readAgentPairingClaimView,
  readAgentPairingClaimWireView as m45_readAgentPairingClaimWireView,
  readChatListView as m45_readChatListView,
  readConnectorOfferCardView as m45_readConnectorOfferCardView,
  readCornerListView as m45_readCornerListView,
  readInviteView as m45_readInviteView,
  readRoomHistoryView as m45_readRoomHistoryView,
  readRoomView as m45_readRoomView,
  readRoomViewMessage as m45_readRoomViewMessage,
  readWorkspaceListView as m45_readWorkspaceListView,
  readWorkspaceMemberListView as m45_readWorkspaceMemberListView,
  readWorkspaceView as m45_readWorkspaceView,
  type SurfaceReader as m45_SurfaceReader,
} from "./phone-guards.js";

import { describe as mergedDescribe45 } from 'vitest';


import { describe as move9_describe, expect as move9_expect, it as move9_it } from 'vitest';


import { readRoomViewMessage as move9_readRoomViewMessage } from "./phone-guards.js";

import { describe as movedDescribe9 } from 'vitest';
type Case = {
  name: string;
  read: m45_SurfaceReader<unknown>;
  base: Record<string, unknown>;
  optionals: readonly string[];
  loadBearingMissing: Record<string, unknown>;
};
export function fixtureScope1() {



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



const cases: Case[] = [
  {
    name: 'RoomView',
    read: m45_readRoomView,
    base: currentRoom,
    optionals: [
      'toolRows',
      'directMessage',
      'parent',
      'briefing',
      'cornerPlan',
      'cornerBrief',
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
    read: m45_readRoomViewMessage,
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
      'daemonFact',
      'systemEvent',
      'awayWarning',
      'presentation',
      'text',
    ],
    loadBearingMissing: { text: 'x', createdAt: 1, author: identity, presentation: 'message' },
  },
  {
    name: 'RoomHistoryView',
    read: m45_readRoomHistoryView,
    base: { roomId, messages: [] },
    optionals: ['nextBefore'],
    loadBearingMissing: { messages: [] },
  },
  {
    name: 'WorkspaceListView',
    read: m45_readWorkspaceListView,
    base: { workspaces: [], viewer: identity, truncated: false, watchFilters: [] },
    optionals: ['truncated', 'watchFilters', 'deletedNotices'],
    loadBearingMissing: { viewer: identity, truncated: false, watchFilters: [] },
  },
  {
    name: 'WorkspaceView',
    read: m45_readWorkspaceView,
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
    read: m45_readWorkspaceMemberListView,
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
    read: m45_readChatListView,
    base: { workspace, chats: [], viewer: identity, truncated: false, watchFilters: [] },
    optionals: ['truncated', 'watchFilters'],
    loadBearingMissing: { chats: [], viewer: identity, truncated: false, watchFilters: [] },
  },
  {
    name: 'CornerListView',
    read: m45_readCornerListView,
    base: { room: header, corners: [], viewer, watchFilters: [] },
    optionals: ['viewer', 'watchFilters'],
    loadBearingMissing: { corners: [], viewer, watchFilters: [] },
  },
  {
    name: 'AgentDetailView',
    read: m45_readAgentDetailView,
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
      'fastMode',
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
    read: m45_readInviteView,
    base: { name: 'Builders', expiresAt: 2_000_000_000 },
    optionals: ['avatar', 'joinedWorkspaceId'],
    loadBearingMissing: { expiresAt: 2_000_000_000 },
  },
  {
    name: 'AgentPairingClaimWireView',
    read: m45_readAgentPairingClaimWireView,
    base: { workspaceId, pairedBy: identity.pubkey, joined: true },
    optionals: ['attachedRoomIds'],
    loadBearingMissing: { pairedBy: identity.pubkey, joined: true },
  },
  {
    name: 'AgentPairingClaimView',
    read: m45_readAgentPairingClaimView,
    base: { workspaceId, pairedBy: identity.pubkey, joined: true, attachedRoomIds: [] },
    optionals: ['attachedRoomIds'],
    loadBearingMissing: { pairedBy: identity.pubkey, joined: true },
  },
  {
    name: 'AgentPairingAbandonView',
    read: m45_readAgentPairingAbandonView,
    base: { abandoned: true },
    optionals: [],
    loadBearingMissing: {},
  },
  {
    name: 'AgentGrantView',
    read: m45_readAgentGrantView,
    base: grant,
    optionals: ['decidedBy', 'decidedAt', 'expiresAt', 'script', 'appName'],
    loadBearingMissing: { ...grant, grantId: undefined },
  },
  {
    name: 'ConnectorOfferCardView',
    read: m45_readConnectorOfferCardView,
    base: connectorOffer,
    optionals: ['acceptedBy', 'acceptedAt', 'connectorId'],
    loadBearingMissing: { ...connectorOffer, offerId: undefined },
  },
];
return {
identity,
agent,
roomId,
workspaceId,
header,
viewer,
currentRoom,
message,
grant,
connectorOffer,
workspace,
cases,
};
}
export function fixtureScope3(scope1: ReturnType<typeof fixtureScope1>) {

  const legacyServerRoom = {
    ...scope1.currentRoom,
    corners: [],
  };

  const futureServerRoom = {
    room: scope1.header,
    messages: [
      {
        ...scope1.message,
        presentation: 'notice',
        futureCard: { kind: 'added-tomorrow' },
      },
    ],
    futureTopLevel: 'server-only',
  };
return {
legacyServerRoom,
futureServerRoom,
};
}
export function fixtureScope4(scope1: ReturnType<typeof fixtureScope1>) {

  const profile = {
    workspaceId: scope1.workspaceId,
    agent: { identity: scope1.agent, role: 'member' },
    catalog: [],
    watchFilters: [],
  };
return {
profile,
};
}
export function fixtureScope5() {



const agent = { pubkey: 'a'.repeat(64), kind: 'agent', name: 'Ruby', handle: 'ruby' };


const human = { pubkey: 'b'.repeat(64), kind: 'human', name: 'Owner', handle: 'owner' };


const base = { id: 'c'.repeat(64), text: 'Approval', createdAt: 1792760000, author: agent, presentation: 'card' };


const squire = { agent, owner: human, tool: 'fetch_credential', title: 'Reveal a key', detail: 'Fly deploy key', approvalUrl: 'https://example.test/approval', linkKind: 'approval', action: 'reveal a key', reason: 'Deploy the preview.', reference: 'vault://owner/fly/key', facts: [{ label: 'Key', value: 'Fly deploy' }], decidedBy: human, decidedAt: 1792760240 };
return {
agent,
human,
base,
squire,
};
}
export { describe as m45_describe, expect as m45_expect, it as m45_it, describe as mergedDescribe45, describe as move9_describe, expect as move9_expect, it as move9_it, describe as movedDescribe9 } from 'vitest';
export { ROOM_VIEW_MESSAGE_LIMIT as m45_ROOM_VIEW_MESSAGE_LIMIT } from './phone-types.js';
export { readAgentDetailView as m45_readAgentDetailView, readAgentGrantView as m45_readAgentGrantView, readAgentPairingAbandonView as m45_readAgentPairingAbandonView, readAgentPairingClaimView as m45_readAgentPairingClaimView, readAgentPairingClaimWireView as m45_readAgentPairingClaimWireView, readChatListView as m45_readChatListView, readConnectorOfferCardView as m45_readConnectorOfferCardView, readCornerListView as m45_readCornerListView, readInviteView as m45_readInviteView, readRoomHistoryView as m45_readRoomHistoryView, readRoomView as m45_readRoomView, readRoomViewMessage as m45_readRoomViewMessage, readWorkspaceListView as m45_readWorkspaceListView, readWorkspaceMemberListView as m45_readWorkspaceMemberListView, readWorkspaceView as m45_readWorkspaceView, readRoomViewMessage as move9_readRoomViewMessage } from './phone-guards.js';
export type { SurfaceReader as m45_SurfaceReader } from './phone-guards.js';
