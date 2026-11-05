
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
mergedDescribe45("phone-guards.tolerance.test.ts", () => {


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
  read: m45_SurfaceReader<unknown>;
  base: Record<string, unknown>;
  optionals: readonly string[];
  loadBearingMissing: Record<string, unknown>;
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


m45_describe('phone surface readers', () => {
  m45_it('preserves the current-card link on expired connector offers and drops invalid links', () => {
    const replacementMessageId = 'f'.repeat(64);
    m45_expect(m45_readConnectorOfferCardView({ ...connectorOffer, status: 'failed', replacementMessageId }))
      .toMatchObject({ replacementMessageId });
    m45_expect(m45_readConnectorOfferCardView({ ...connectorOffer, replacementMessageId: 42 }))
      .not.toHaveProperty('replacementMessageId');
  });
  m45_it('preserves approval purpose and facts while tolerating old or malformed optional metadata', () => {
    const facts = { purpose: 'Free space so the Android build can finish', machine: 'squire', touches: 'Archived build output', capabilities: 'Delete files' };
    m45_expect(m45_readAgentGrantView({ ...grant, ...facts })).toMatchObject(facts);
    m45_expect(m45_readAgentGrantView(grant)).not.toHaveProperty('purpose');
    const invalid = m45_readAgentGrantView({ ...grant, purpose: 'x'.repeat(241), touches: 42, capabilities: null });
    m45_expect(invalid).not.toBeNull();
    m45_expect(invalid).not.toHaveProperty('purpose');
    m45_expect(invalid).not.toHaveProperty('touches');
    m45_expect(invalid).not.toHaveProperty('capabilities');
  });

  m45_it('preserves connection app display names in grant cards', () => {
    m45_expect(m45_readAgentGrantView({ ...grant, kind: 'mcp', target: 'connection-install:github', appName: 'GitHub' })?.appName).toBe('GitHub');
  });
  m45_it('preserves standing Wallet cards and legacy time-limited cards', () => {
    m45_expect(
      m45_readRoomViewMessage({ ...message, walletDelegation: { standing: true } })?.walletDelegation,
    ).toEqual({ standing: true });
    m45_expect(
      m45_readRoomViewMessage({
        ...message,
        walletDelegation: { expiresAt: 1_800_000_000, ttlHours: 24 },
      })?.walletDelegation,
    ).toEqual({ expiresAt: 1_800_000_000, ttlHours: 24 });
  });
  for (const entry of cases) {
    m45_describe(entry.name, () => {
      m45_it('keeps the view when an unknown field arrives', () => {
        m45_expect(
          entry.read({ ...entry.base, unexpectedServerField: { nested: true } }),
        ).not.toBeNull();
      });

      for (const optional of entry.optionals) {
        m45_it(`keeps the view when ${optional} is absent`, () => {
          const { [optional]: _omitted, ...rest } = entry.base;
          m45_expect(entry.read(rest)).not.toBeNull();
        });
      }

      m45_it('fails only when load-bearing identity is missing', () => {
        m45_expect(entry.read(entry.loadBearingMissing)).toBeNull();
      });
    });
  }

  m45_it('drops an unreadable list entry instead of blanking the Room', () => {
    const view = m45_readRoomView({
      ...currentRoom,
      messages: [
        message,
        { id: 'not-a-message' },
        { ...message, id: 'd'.repeat(64), text: 'kept' },
      ],
    });
    m45_expect(view?.messages.map((row) => row.text)).toEqual(['Change course', 'kept']);
  });

  m45_it('preserves a corner opener and drops an invalid opener id', () => {
    m45_expect(m45_readRoomView({ ...currentRoom, cornerOpenerAgentId: 'b'.repeat(64) })?.cornerOpenerAgentId)
      .toBe('b'.repeat(64));
    m45_expect(m45_readRoomView({ ...currentRoom, cornerOpenerAgentId: 'invalid' })?.cornerOpenerAgentId)
      .toBeUndefined();
  });

  m45_it('preserves a saved brief, its exact approval quote, and its files for the objective panel', () => {
    const cornerBrief = {
      authorHandle: 'ruby',
      revision: 2,
      spec: '## Intent\n\n> Read the saved request\n\n## Checklist\n\n- Keep every detail',
      approval: {
        sourceMessageId: 'b'.repeat(64),
        text: 'Keep this\n\nexact quote.',
        approverName: 'Owner',
      },
      attachments: [
        { title: 'Plan', purpose: 'Reference', required: true, url: 'https://example.com/plan' },
      ],
    };
    m45_expect(m45_readRoomView({ ...currentRoom, cornerBrief })?.cornerBrief).toEqual(cornerBrief);
    const { approval: _approval, ...legacy } = cornerBrief;
    m45_expect(m45_readRoomView({ ...currentRoom, cornerBrief: legacy })?.cornerBrief).toEqual(legacy);
    m45_expect(m45_readRoomView(currentRoom)?.cornerBrief).toBeUndefined();
  });

  m45_it('contains malformed brief data without losing the Room or its valid spec', () => {
    const cornerBrief = { revision: 1, spec: 'Saved spec', attachments: [] };
    for (const invalid of [
      null,
      {},
      { ...cornerBrief, revision: 0 },
      { ...cornerBrief, revision: 1.5 },
      { ...cornerBrief, spec: false },
      { ...cornerBrief, attachments: {} },
    ]) {
      const view = m45_readRoomView({ ...currentRoom, cornerBrief: invalid });
      m45_expect(view?.room.id).toBe(roomId);
      m45_expect(view?.cornerBrief).toBeUndefined();
    }
    m45_expect(
      m45_readRoomView({
        ...currentRoom,
        cornerBrief: {
          ...cornerBrief,
          approval: { sourceMessageId: 'invalid', text: 'Quote', approverName: 'Owner' },
          attachments: [
            { title: 'Bad file', purpose: 'Reference', required: true, url: 'javascript:alert(1)' },
          ],
        },
      })?.cornerBrief,
    ).toEqual(cornerBrief);
  });

  m45_it('preserves a Squire request source link through the Room message reader', () => {
    const sourceMessageId = 'd'.repeat(64);
    const grantRequest = {
      agent,
      owner: identity,
      requester: identity,
      grants: [grant],
      sourceRoomId: roomId,
      sourceMessageId,
    };
    const view = m45_readRoomView({
      ...currentRoom,
      messages: [{ ...message, grantRequest }],
    });
    m45_expect(view?.messages[0]?.grantRequest).toMatchObject({
      sourceRoomId: roomId,
      sourceMessageId,
    });

    const invalid = m45_readRoomViewMessage({
      ...message,
      grantRequest: { ...grantRequest, sourceMessageId: 'not-a-message-id' },
    });
    m45_expect(invalid?.grantRequest).toBeDefined();
    m45_expect(invalid?.grantRequest?.sourceRoomId).toBeUndefined();
    m45_expect(invalid?.grantRequest?.sourceMessageId).toBeUndefined();
  });

  m45_it('retains the pending app sign-in card for the Room and rejects malformed authority', () => {
    const appSignIn = { appId: roomId, appKey: 'slack', name: 'Slack',
      ownerId: identity.pubkey, agentId: agent.pubkey, status: 'pending' as const,
      continuation: 'Bee posts the notes right after.' };
    m45_expect(m45_readRoomViewMessage({ ...message, presentation: 'card', appSignIn })?.appSignIn)
      .toEqual(appSignIn);
    m45_expect(m45_readRoomViewMessage({ ...message, appSignIn: { ...appSignIn,
      logo: 'https://cdn.example.test/slack.png', domain: 'slack.com' } })?.appSignIn)
      .toMatchObject({ logo: 'https://cdn.example.test/slack.png', domain: 'slack.com' });
    m45_expect(m45_readRoomViewMessage({ ...message, appSignIn: { ...appSignIn,
      logo: 'javascript:alert(1)', domain: 123 } })?.appSignIn).toEqual(appSignIn);
    m45_expect(m45_readRoomViewMessage({ ...message, appSignIn: { ...appSignIn, ownerId: 'other' } })
      ?.appSignIn).toBeUndefined();
    m45_expect(m45_readRoomViewMessage({ ...message, appSignIn: { ...appSignIn, continuation: 'x'.repeat(161) } })
      ?.appSignIn?.continuation).toBeUndefined();
    m45_expect(m45_readRoomViewMessage({ ...message, appSignIn: { ...appSignIn,
      status: 'failed', errorMessage: 'Provider rejected this account type' } })?.appSignIn)
      .toMatchObject({ status: 'failed', errorMessage: 'Provider rejected this account type' });
    m45_expect(m45_readRoomViewMessage({ ...message, appSignIn: { ...appSignIn,
      status: 'failed', errorMessage: 'x'.repeat(501) } })?.appSignIn?.errorMessage)
      .toBeUndefined();
  });

  m45_it('retains an @agent login card for each sign-in kind and drops anything else', () => {
    const base = { agentId: agent.pubkey, ownerId: identity.pubkey, harness: 'claude' as const };
    const pasteCode = { ...base, status: 'pending' as const, kind: 'paste-code' as const,
      authorizeUrl: 'https://claude.com/cai/oauth/authorize?code=true' };
    m45_expect(m45_readRoomViewMessage({ ...message, presentation: 'card', agentSignIn: pasteCode })?.agentSignIn)
      .toEqual(pasteCode);
    const device = { ...base, harness: 'codex' as const, status: 'pending' as const, kind: 'device-code' as const,
      authorizeUrl: 'https://auth.openai.com/codex/device', userCode: 'EBQ9-VJCLN', expiresAt: 1_800_000_000_000 };
    m45_expect(m45_readRoomViewMessage({ ...message, agentSignIn: device })?.agentSignIn).toEqual(device);
    const key = { ...base, harness: 'pi' as const, status: 'pending' as const, kind: 'api-key' as const,
      provider: 'openrouter' as const };
    m45_expect(m45_readRoomViewMessage({ ...message, agentSignIn: key })?.agentSignIn).toEqual(key);
    m45_expect(m45_readRoomViewMessage({ ...message, agentSignIn: { ...pasteCode,
      authorizeUrl: 'http://claude.com/x', attemptId: 'kept-server-side', code: 'never',
      userCode: 'lower-case', provider: 'acme' } })?.agentSignIn)
      .toEqual({ ...base, status: 'pending', kind: 'paste-code' });
    m45_expect(m45_readRoomViewMessage({ ...message, agentSignIn: { ...pasteCode, status: 'done' } })
      ?.agentSignIn).toBeUndefined();
    m45_expect(m45_readRoomViewMessage({ ...message, agentSignIn: { ...pasteCode, harness: 'custom' } })
      ?.agentSignIn).toBeUndefined();
    m45_expect(m45_readRoomViewMessage({ ...message, agentSignIn: { ...pasteCode, ownerId: 'other' } })
      ?.agentSignIn).toBeUndefined();
  });

  m45_it('preserves a Squire-owned approval link and drops malformed destinations', () => {
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
    m45_expect(m45_readRoomViewMessage({ ...message, squireApproval })?.squireApproval).toEqual(
      squireApproval,
    );
    m45_expect(
      m45_readRoomViewMessage({
        ...message,
        squireApproval: { ...squireApproval, approvalUrl: 'javascript:alert(1)' },
      })?.squireApproval,
    ).toBeUndefined();
  });

  m45_it('keeps a computer card in live messages, Room reads, and serialized cache reads for every reader', () => {
    const id = 'gQp5M3DgFFI04Qazuj5xVz1M6k8dCbvq8VQDbauwmfw';
    const computerSession = {
      id, url: `https://server.usebeeline.app/s/${id}/`,
      title: "Ruby's Chrome: TikTok QR sign-in", status: 'live' as const,
    };
    const cardMessage = { ...message, presentation: 'card', text: '@ruby shared a live browser', computerSession };
    m45_expect(m45_readRoomViewMessage(cardMessage)?.computerSession).toEqual(computerSession);
    for (const permissions of [{ send: true, manage: true }, { send: false, manage: false }]) {
      const room = m45_readRoomView(JSON.parse(JSON.stringify({
        ...currentRoom, viewer: { ...viewer, permissions }, messages: [cardMessage],
      })));
      m45_expect(room?.messages[0]?.computerSession).toEqual(computerSession);
    }
    m45_expect(m45_readRoomViewMessage({ ...cardMessage, computerSession: { ...computerSession, status: 'ended' } })
      ?.computerSession?.status).toBe('ended');
    m45_expect(m45_readRoomViewMessage({ ...cardMessage, computerSession: { ...computerSession,
      url: 'javascript:alert(1)' } })?.computerSession).toBeUndefined();
    m45_expect(m45_readRoomViewMessage({ ...cardMessage, computerSession: { ...computerSession,
      url: `${computerSession.url}?access=secret` } })?.computerSession).toBeUndefined();
  });

  m45_it('keeps the deck when the Workspace names a role or visibility this bundle does not know', () => {
    const view = m45_readChatListView({
      workspace: { ...workspace, visibility: 'unlisted', role: 'steward' },
      chats: [],
      viewer: identity,
      truncated: false,
      watchFilters: [],
    });
    m45_expect(view?.workspace.id).toBe(workspaceId);
    m45_expect(view?.workspace.visibility).toBeUndefined();
    m45_expect(view?.workspace.role).toBe('member');
  });

  m45_it('keeps a deck row whose counts the server stopped sending, as unknown rather than zero', () => {
    const view = m45_readChatListView({
      workspace,
      chats: [{ room: header }],
      viewer: identity,
      truncated: false,
      watchFilters: [],
    });
    m45_expect(view?.chats).toHaveLength(1);
    m45_expect(view?.chats[0]?.memberCount).toBeUndefined();
    m45_expect(view?.chats[0]?.cornerCount).toBeUndefined();
    m45_expect(view?.chats[0]?.unread).toBeUndefined();
  });

  m45_it('preserves the last-manager deletion warning on Room and deck reads', () => {
    m45_expect(m45_readRoomView({ ...currentRoom, leaveDeletesRoom: true })?.leaveDeletesRoom).toBe(true);
    const view = m45_readChatListView({
      workspace,
      chats: [{ room: header, leaveDeletesRoom: true }],
      viewer: identity,
      truncated: false,
      watchFilters: [],
    });
    m45_expect(view?.chats[0]?.leaveDeletesRoom).toBe(true);
  });

  m45_it('reads open corners and drops rows it cannot render', () => {
    const cornerId = '44444444-4444-4444-8444-444444444444';
    const view = m45_readChatListView({
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
    m45_expect(view?.chats[0]?.openCorners).toEqual([
      { id: cornerId, name: 'Open corner', state: 'waiting' },
      { id: cornerId, name: 'Mine', state: 'review', mine: true },
      { id: cornerId, name: 'Not a flag', state: 'working' },
    ]);
  });

  m45_it('reads the corners page summary whole, or not at all', () => {
    const cornerId = '44444444-4444-4444-8444-444444444444';
    const base = { room: header, corners: [], viewer, watchFilters: [] };
    const summary = {
      cornerCount: 2, waitingCornerCount: 1, mineCornerCount: 1,
      openCorners: [{ id: cornerId, name: 'Mine', state: 'waiting', mine: true,
        waitingSince: 5, attention: true }],
    };
    m45_expect(m45_readCornerListView({ ...base, summary })?.summary).toEqual(summary);
    m45_expect(m45_readCornerListView({ ...base, summary: { ...summary, cornerCount: -1 } }))
      .not.toHaveProperty('summary');
    m45_expect(m45_readCornerListView({ ...base, summary: { ...summary, openCorners: 'none' } }))
      .not.toHaveProperty('summary');
  });

  m45_it('keeps a Room preview whose latest message id is not hex', () => {
    // Reproduction R1: a DM whose newest row was an automatic failure report
    // read "No messages yet" with the Room's creation time.
    for (const id of [`failure:${'d'.repeat(64)}:0`, '11111111-2222-4333-8444-555555555555']) {
      const view = m45_readChatListView({
        workspace,
        chats: [{ room: header, latestMessage: { id, text: 'failed: label-bg-audit', createdAt: 9, author: agent } }],
        viewer: identity,
        truncated: false,
        watchFilters: [],
      });
      m45_expect(view?.chats[0]?.latestMessage).toMatchObject({ id, text: 'failed: label-bg-audit', createdAt: 9 });
    }
  });

  m45_it('keeps exact viewer-attention facts and ignores malformed reasons', () => {
    const latest = {
      id: 'a'.repeat(64),
      text: '@viewer please look',
      createdAt: 1,
      author: identity,
      mentionsViewer: true,
    };
    const view = m45_readChatListView({
      workspace,
      chats: [
        {
          room: header,
          latestMessage: latest,
          agentState: 'needs-you',
          attentionReason: { kind: 'approval', actor: 'Hoots' },
        },
      ],
      viewer: identity,
      truncated: false,
      watchFilters: [],
    });
    m45_expect(view?.chats[0]?.latestMessage?.mentionsViewer).toBe(true);
    m45_expect(view?.chats[0]?.attentionReason).toEqual({ kind: 'approval', actor: 'Hoots' });
  });

  m45_it('preserves valid waiting counts without inventing them for older servers', () => {
    for (const count of [undefined, -1, '2', 2, 0]) {
      const view = m45_readChatListView({
        workspace,
        chats: [{ room: header, waitingCornerCount: count }],
        viewer: identity,
        truncated: false,
        watchFilters: [],
      });
      m45_expect(view?.chats[0]?.waitingCornerCount).toBe(
        typeof count === 'number' && count >= 0 ? count : undefined,
      );
    }
  });

  m45_it('drops a watch filter it cannot read whole rather than widening the subscription', () => {
    m45_expect(
      m45_readRoomView({ ...currentRoom, watchFilters: [{ '#h': 'not-an-array' }] })?.watchFilters,
    ).toEqual([]);
    m45_expect(
      m45_readRoomView({
        ...currentRoom,
        watchFilters: [{ kinds: [9], '#h': 'not-an-array' }],
      })?.watchFilters,
    ).toEqual([]);
    m45_expect(
      m45_readRoomView({
        ...currentRoom,
        watchFilters: [{ kinds: [9], '#e': [roomId] }],
      })?.watchFilters,
    ).toEqual([]);
    m45_expect(
      m45_readRoomView({
        ...currentRoom,
        watchFilters: [{ kinds: [9], '#h': [roomId] }],
      })?.watchFilters,
    ).toEqual([{ kinds: [9], '#h': [roomId] }]);
    m45_expect(
      m45_readRoomView({
        ...currentRoom,
        watchFilters: Array.from({ length: 40 }, () => ({ '#h': [roomId] })),
      })?.watchFilters,
    ).toHaveLength(32);
  });

  m45_it('keeps the newest rows when the server sends more messages than this bundle caps', () => {
    const sent = Array.from({ length: m45_ROOM_VIEW_MESSAGE_LIMIT + 10 }, (_, index) => ({
      ...message,
      id: index.toString(16).padStart(64, '0'),
      text: `message ${index}`,
      createdAt: index + 1,
    }));
    const view = m45_readRoomView({ ...currentRoom, messages: sent });
    m45_expect(view?.messages).toHaveLength(m45_ROOM_VIEW_MESSAGE_LIMIT);
    m45_expect(view?.messages.at(-1)?.text).toBe(`message ${sent.length - 1}`);
    m45_expect(view?.messages[0]?.text).toBe(`message ${sent.length - m45_ROOM_VIEW_MESSAGE_LIMIT}`);
  });

  m45_it('rejects a history page with an unreadable row instead of claiming its boundary', () => {
    m45_expect(m45_readRoomHistoryView({ roomId, messages: [{ ...message, id: 'invalid' }] })).toBeNull();
    m45_expect(
      m45_readRoomHistoryView({ roomId, messages: [message], nextBefore: { createdAt: 10 } }),
    ).toBeNull();
    m45_expect(m45_readRoomHistoryView({ roomId, messages: [message] })?.messages).toHaveLength(1);
  });

  m45_it('omits an unreadable createdAt, updatedAt or archived instead of inventing one', () => {
    const { createdAt: _c, updatedAt: _u, archived: _a, ...bareHeader } = header;
    const view = m45_readRoomView({ ...currentRoom, room: bareHeader });
    m45_expect(view?.room.id).toBe(roomId);
    m45_expect('createdAt' in (view?.room ?? {})).toBe(false);
    m45_expect('updatedAt' in (view?.room ?? {})).toBe(false);
    m45_expect('archived' in (view?.room ?? {})).toBe(false);

    const wrongTypes = m45_readRoomView({
      ...currentRoom,
      room: { ...header, createdAt: 'yesterday', updatedAt: -1, archived: 'no' },
    });
    m45_expect(wrongTypes?.room.createdAt).toBeUndefined();
    m45_expect(wrongTypes?.room.updatedAt).toBeUndefined();
    m45_expect(wrongTypes?.room.archived).toBeUndefined();
    m45_expect(m45_readRoomView({ ...currentRoom, room: header })?.room.updatedAt).toBe(2);
  });

  m45_it('drops a reply anchor that names another Room instead of carrying it through', () => {
    const foreign = 'cccccccc-3333-4333-8333-cccccccccccc';
    const view = m45_readRoomView({
      ...currentRoom,
      messages: [
        {
          ...message,
          reference: { channelId: foreign, eventId: message.id, rootId: 'd'.repeat(64) },
          reply: { channelId: foreign, eventId: 'e'.repeat(64), rootId: 'f'.repeat(64) },
        },
      ],
    });
    m45_expect(view?.messages).toHaveLength(1);
    m45_expect(view?.messages[0]?.reference).toBeUndefined();
    m45_expect(view?.messages[0]?.reply).toBeUndefined();

    const sameRoom = m45_readRoomView({
      ...currentRoom,
      messages: [
        {
          ...message,
          reference: { channelId: roomId, eventId: message.id, rootId: 'd'.repeat(64) },
          reply: { channelId: roomId, eventId: 'e'.repeat(64), rootId: 'f'.repeat(64) },
        },
      ],
    });
    m45_expect(sameRoom?.messages[0]?.reference).toEqual({
      channelId: roomId,
      eventId: message.id,
      rootId: 'd'.repeat(64),
    });
    m45_expect(sameRoom?.messages[0]?.reply).toEqual({
      channelId: roomId,
      eventId: 'e'.repeat(64),
      rootId: 'f'.repeat(64),
    });
  });

  m45_it('reads an unnameable repositoryResolution as unverified, never as no repository', () => {
    m45_expect(
      m45_readRoomView({ ...currentRoom, repositoryResolution: 'scratch' })?.repositoryResolution,
    ).toBe('unverified');
    const { repositoryResolution: _omitted, ...withoutResolution } = currentRoom;
    m45_expect(m45_readRoomView(withoutResolution)?.repositoryResolution).toBe('unverified');
  });

  m45_it('keeps a message when an optional card field is a kind this bundle does not know', () => {
    const view = m45_readRoomView({
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
    m45_expect(view?.messages).toHaveLength(1);
    m45_expect(view?.messages[0]?.presentation).toBe('message');
    m45_expect(view?.messages[0]?.githubEvent?.type).toBe('release');
  });

  m45_it('reads a person-opened corner card by its name and keeps its source message', () => {
    const cornerId = 'cccccccc-3333-4333-8333-cccccccccccc';
    const read = (daemonFact: Record<string, unknown>) =>
      m45_readRoomViewMessage({ ...message, presentation: 'card', daemonFact })?.daemonFact;
    m45_expect(
      read({
        type: 'corner-open',
        cornerId,
        name: 'quiet amber corner',
        objective: '',
        sourceMessageId: 'd'.repeat(64),
      }),
    ).toEqual({
      type: 'corner-open',
      cornerId,
      name: 'quiet amber corner',
      objective: '',
      sourceMessageId: 'd'.repeat(64),
    });
    // With neither an objective nor a name there is nothing to title it by.
    m45_expect(read({ type: 'corner-open', cornerId, objective: '' })).toBeUndefined();
    // An agent card from before the marker still reads without a source.
    m45_expect(read({ type: 'corner-open', cornerId, objective: 'Fix the auth test' })).toEqual({
      type: 'corner-open',
      cornerId,
      objective: 'Fix the auth test',
    });
  });
});


m45_describe('Room payload compatibility in both directions', () => {
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

  m45_it('renders a pre-1516 Room (corners present) and a post-1516 Room (corners absent)', () => {
    m45_expect(m45_readRoomView(legacyServerRoom)?.room.id).toBe(roomId);
    m45_expect(m45_readRoomView(currentRoom)?.room.id).toBe(roomId);
  });

  m45_it('renders a future Room that an older all-or-nothing check would blank', () => {
    const view = m45_readRoomView(futureServerRoom);
    m45_expect(view?.room.id).toBe(roomId);
    m45_expect(view?.messages).toHaveLength(1);
  });

  m45_it('renders the older server shape after this bundle and the newer shape before a later server change', () => {
    m45_expect(m45_readRoomView(legacyServerRoom)?.messages).toEqual([]);
    m45_expect(m45_readRoomView(futureServerRoom)?.messages[0]?.text).toBe('Change course');
  });
});


m45_describe('agent profile recent work', () => {
  const profile = {
    workspaceId,
    agent: { identity: agent, role: 'member' },
    catalog: [],
    watchFilters: [],
  };
  m45_it('keeps each model choice description so an alias can name its model', () => {
    const catalog = [{
      id: 'model', category: 'model', currentValue: 'default',
      options: [{ id: 'default', name: 'Default (recommended)', description: 'Opus' }, { id: 'opus', name: 'Opus 5.5', description: 7 }],
    }];
    m45_expect(m45_readAgentDetailView({ ...profile, catalog })?.catalog[0]?.options).toEqual([
      { id: 'default', name: 'Default (recommended)', description: 'Opus' },
      { id: 'opus', name: 'Opus 5.5' },
    ]);
  });
  m45_it('projects wake status without ever retaining a bearer key', () => {
    const wake = { url: 'https://hooks.example/wake', keySet: true, key: 'private-key' };
    m45_expect(m45_readAgentDetailView({ ...profile, wake })?.wake).toEqual({ url: wake.url, keySet: true });
    m45_expect(m45_readAgentDetailView(profile)?.wake).toBeUndefined();
    m45_expect(m45_readAgentDetailView({ ...profile, wake: { url: null, keySet: false } })?.wake).toEqual({ url: null, keySet: false });
    m45_expect(m45_readAgentDetailView({ ...profile, wake: { url: wake.url, keySet: 'true' } })?.wake).toBeUndefined();
  });
  m45_it('preserves only boolean login verdicts and fails closed on missing or malformed values', () => {
    m45_expect(m45_readAgentDetailView({ ...profile, canLogin: true })?.canLogin).toBe(true);
    m45_expect(m45_readAgentDetailView({ ...profile, canLogin: false })?.canLogin).toBe(false);
    m45_expect(m45_readAgentDetailView({ ...profile, canLogin: 'true' })?.canLogin).toBeUndefined();
    m45_expect(m45_readAgentDetailView(profile)?.canLogin).toBeUndefined();
  });
  m45_it('reads old servers without work and rejects unsafe links without dropping the profile', () => {
    m45_expect(m45_readAgentDetailView(profile)?.recentWork).toEqual([]);
    const work = { title: 'Visible merged work', url: 'https://github.com/acme/repo/pull/12' };
    m45_expect(
      m45_readAgentDetailView({
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


m45_it.each(['approve', 'connect', 'question'] as const)(
  'R1 preserves optional %s reason and item link in the corner contract', (reason) => {
    const corner = { corner: header, lifecycle: { lifecycle: 'open', checks: 'unknown' },
      state: 'waiting', reason, itemId: 'blocking-message' };
    const decoded = m45_readCornerListView({ room: header, corners: [corner], viewer, watchFilters: [] });
    m45_expect(decoded?.corners[0]).toMatchObject({ state: 'waiting', reason, itemId: 'blocking-message' });
    const legacy = m45_readCornerListView({ room: header, corners: [{ ...corner, reason: undefined, itemId: undefined }], viewer, watchFilters: [] });
    m45_expect(legacy?.corners[0]?.state).toBe('waiting');
    m45_expect(legacy?.corners[0]?.reason).toBeUndefined();
  },
);


m45_it('preserves validated merge-queue state in a corner response', () => {
  const mergeQueue = { headSha: 'a'.repeat(40), combinedSha: 'b'.repeat(40) };
  const corner = { corner: header, state: 'review', lifecycle: { lifecycle: 'in-review', checks: 'passing', mergeQueue } };
  const response = m45_readCornerListView({ room: header, corners: [corner], viewer, watchFilters: [] });
  m45_expect(response?.corners[0]?.lifecycle.mergeQueue).toEqual(mergeQueue);
  const invalid = { ...corner, lifecycle: { ...corner.lifecycle, mergeQueue: { headSha: 'invalid' } } };
  m45_expect(m45_readCornerListView({ room: header, corners: [invalid], viewer, watchFilters: [] })?.corners[0]?.lifecycle.mergeQueue)
    .toBeUndefined();
});


m45_it('keeps a validated corner destination on repository events', () => {
  const event = { type: 'pull-request', action: 'merged', actor: 'ruby', title: 'Work',
    url: 'https://github.com/owner/widgets/pull/1', cornerId: roomId };
  const read = (githubEvent: unknown) => m45_readRoomViewMessage({ ...message, githubEvent })?.githubEvent;
  m45_expect(read(event)?.cornerId).toBe(roomId);
  m45_expect(read({ ...event, cornerId: 'invalid' })?.cornerId).toBeUndefined();
});


m45_it('keeps the message text when a preceding phone cannot recognize a newly registered event kind', () => {
  const event = {subject:{kind:'person',name:'Owner'},verb:'left',kind:'future-event'};
  const decoded = m45_readRoomViewMessage({...message,presentation:'system',text:'Owner left',systemEvent:event});
  m45_expect(decoded).toMatchObject({id:message.id,text:'Owner left',presentation:'system'});
  m45_expect(decoded?.systemEvent).toBeUndefined();
  m45_expect(m45_readRoomViewMessage({...message,systemEvent:{...event,kind:'left'}})?.systemEvent?.kind).toBe('left');
});
});

import { describe as move9_describe, expect as move9_expect, it as move9_it } from 'vitest';

import { readRoomViewMessage as move9_readRoomViewMessage } from "./phone-guards.js";
import { describe as movedDescribe9 } from 'vitest';
movedDescribe9("phone-guards.approvals.test.ts", () => {


const agent = { pubkey: 'a'.repeat(64), kind: 'agent', name: 'Ruby', handle: 'ruby' };

const human = { pubkey: 'b'.repeat(64), kind: 'human', name: 'Owner', handle: 'owner' };

const base = { id: 'c'.repeat(64), text: 'Approval', createdAt: 1792760000, author: agent, presentation: 'card' };

const squire = { agent, owner: human, tool: 'fetch_credential', title: 'Reveal a key', detail: 'Fly deploy key', approvalUrl: 'https://example.test/approval', linkKind: 'approval', action: 'reveal a key', reason: 'Deploy the preview.', reference: 'vault://owner/fly/key', facts: [{ label: 'Key', value: 'Fly deploy' }], decidedBy: human, decidedAt: 1792760240 };


move9_describe('production approval message parsing', () => {
  move9_it.each(['approved', 'denied', 'expired'])('preserves Squire %s state and presentation', status => {
    const payload = { ...squire, status };
    move9_expect(move9_readRoomViewMessage({ ...base, squireApproval: payload })?.squireApproval).toEqual(payload);
  });
  move9_it.each(['allowed', 'denied'])('preserves target %s decision and purpose', status => {
    const targetBranch = { proposalId: 'proposal', from: 'main', to: 'release', agent, requester: human, purpose: 'Ship the fixes.', status, decidedBy: human, decidedAt: 1792760240 };
    move9_expect(move9_readRoomViewMessage({ ...base, targetBranch })?.targetBranch).toEqual(targetBranch);
  });
  move9_it('preserves permission reason, timestamp and verified decision maker', () => {
    const permission = { permissionId: 'permission', requestId: 'request', agent, requester: human, tool: 'edit_file', status: 'allowed', reason: 'Update README.', decider: human, decidedAt: 1792760240 };
    move9_expect(move9_readRoomViewMessage({ ...base, permission })?.permission).toEqual(permission);
  });
  move9_it('omits malformed optional fields and never treats an agent as the human decider', () => {
    const result = move9_readRoomViewMessage({ ...base, squireApproval: { ...squire, owner: agent, decidedBy: agent, decidedAt: 'yesterday', status: 'other', action: {}, reason: [], reference: 9, facts: [{ label: 'Key', value: 9 }] }, targetBranch: { proposalId: 'p', from: 'main', to: 'release', decidedBy: agent, decidedAt: NaN, purpose: {}, status: 'other' } });
    move9_expect(result?.squireApproval).toMatchObject({ agent, tool: 'fetch_credential' });
    for (const key of ['owner', 'decidedBy', 'decidedAt', 'status', 'action', 'reason', 'reference']) move9_expect(result?.squireApproval).not.toHaveProperty(key);
    move9_expect(result?.squireApproval?.facts).toEqual([]);
    for (const key of ['decidedBy', 'decidedAt', 'purpose', 'status']) move9_expect(result?.targetBranch).not.toHaveProperty(key);
  });
});
});
