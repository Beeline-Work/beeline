import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  createAgentPairingCode,
  createCommunityInviteToken,
  isAgentPairingCode,
  isCommunityInviteToken,
  normalizeAgentPairingCode,
  isCornerListView,
  isInviteView,
  isRoomView,
  isWorkspaceListView,
  isWorkspaceMemberListView,
  isWorkspaceView,
  readCornerListView,
  readInviteView,
  readRoomView,
  readWorkspaceView,
  isPushLevel,
  WORKSPACE_MEMBER_PAGE_SIZE,
  type PhoneOperationMap,
} from './phone.js';

const identity = { pubkey: 'a'.repeat(64), kind: 'human' as const, name: 'Owner' };

describe('phone contract', () => {
  it('validates extracted RoomView responses and rejects malformed nested state', () => {
    const room = {
      room: {
        id: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
        workspaceId: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb',
        name: 'Launch',
        archived: false,
        createdAt: 1,
        updatedAt: 2,
      },
      messages: [],
      members: [],
      latestAgentTurns: [],
      repositoryResolution: 'none',
      viewer: { identity, role: 'owner', permissions: { send: true, manage: true } },
      watchFilters: [],
    };
    expect(isRoomView(room)).toBe(true);
    const relay = {
      fromRoomId: room.room.id,
      toRoomId: room.room.id,
      direction: 'down',
      fromName: 'beeline',
      cornerId: 'corner',
      received: true,
    };
    const message = {
      id: 'b'.repeat(64),
      text: 'Change course',
      createdAt: 1,
      author: identity,
      presentation: 'card',
      relay,
    };
    expect(isRoomView({ ...room, messages: [message] })).toBe(true);
    expect(isRoomView({ ...room, messages: [{ ...message, createdAtMs: 1_999 }] })).toBe(true);
    expect(
      readRoomView({ ...room, messages: [{ ...message, createdAtMs: 1.5 }] })?.messages,
    ).toEqual([{ ...message, presentation: 'card', relay }]);
    expect(isRoomView({ ...room, messages: [{ ...message, bookmarked: true }] })).toBe(true);
    expect(
      readRoomView({ ...room, messages: [{ ...message, bookmarked: 'yes' }] })?.messages[0]
        ?.bookmarked,
    ).toBeUndefined();
    const reaction = { emoji: '👍', count: 1, reacted: true, members: [identity] };
    expect(isRoomView({ ...room, messages: [{ ...message, reactions: [reaction] }] })).toBe(true);
    expect(
      isRoomView({
        ...room,
        messages: [{ ...message, reactions: [{ emoji: '👍', count: 1, reacted: true }] }],
      }),
    ).toBe(true);
    expect(
      readRoomView({
        ...room,
        messages: [{ ...message, reactions: [{ ...reaction, count: 2 }] }],
      })?.messages[0]?.reactions?.[0]?.count,
    ).toBe(2);
    for (const invalid of [{ direction: 'sideways' }, { received: 'yes' }, { fromName: 1 }])
      expect(
        readRoomView({ ...room, messages: [{ ...message, relay: { ...relay, ...invalid } }] })
          ?.messages[0]?.relay,
      ).toBeUndefined();
    expect(
      readRoomView({
        ...room,
        messages: [{ ...message, relay: { ...relay, anchorMessageId: 42 } }],
      })?.messages[0]?.relay,
    ).toEqual(relay);

    // The face ceremony: an optional face id on every identity, never a non-string.
    expect(
      isRoomView({ ...room, viewer: { ...room.viewer, identity: { ...identity, face: 'owl' } } }),
    ).toBe(true);
    expect(
      readRoomView({ ...room, viewer: { ...room.viewer, identity: { ...identity, face: 7 } } })
        ?.viewer.identity.face,
    ).toBeUndefined();
    expect(
      readRoomView({ ...room, latestAgentTurns: [{ status: 'working' }] })?.latestAgentTurns,
    ).toEqual([]);

    const agent = { pubkey: 'c'.repeat(64), kind: 'agent' as const, name: 'Bee' };
    const choice = {
      choiceId: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
      mode: 'poll',
      status: 'closed',
      agent,
      prompt: 'Which paper API?',
      options: [
        {
          optionId: 'A',
          letter: 'A',
          label: 'Kraken paper',
          consequence: 'plugin auth',
          votes: 2,
          share: 1,
          leader: true,
        },
        {
          optionId: 'B',
          letter: 'B',
          label: 'Keep waiting',
          consequence: 'blocked',
          votes: 1,
          share: 0.5,
        },
      ],
      electorate: [identity.pubkey],
      votedCount: 3,
      electorateCount: 4,
      responses: [{ identityId: identity.pubkey, optionId: 'A' }],
      outcome: 'winner',
      footer: 'closed · 3 of 4 voted',
    };
    expect(isRoomView({ ...room, messages: [{ ...message, choice }] })).toBe(true);
    const humanPoll = { ...choice, status: 'open', agent: identity };
    expect(
      readRoomView({ ...room, messages: [{ ...message, choice: humanPoll }] })?.messages[0]?.choice,
    ).toEqual(humanPoll);
    expect(
      readRoomView({
        ...room,
        messages: [{ ...message, choice: { ...humanPoll, mode: 'question' } }],
      })?.messages[0]?.choice,
    ).toBeUndefined();
    expect(
      readRoomView({ ...room, messages: [{ ...message, choice: { ...choice, mode: 'vote' } }] })
        ?.messages[0]?.choice,
    ).toBeUndefined();
  });

  it('keeps list guards and named operations type-visible', () => {
    expect(
      isWorkspaceListView({ workspaces: [], viewer: identity, truncated: false, watchFilters: [] }),
    ).toBe(true);
    const workspace = {
      workspace: {
        id: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb',
        name: 'Hive',
        visibility: 'invite-only' as const,
        role: 'owner' as const,
        createdAt: 1,
        updatedAt: 1,
      },
      members: [] as Array<{ identity: typeof identity; role: 'member' }>,
      agents: [],
      peopleTotal: 21,
      agentTotal: 0,
      membersTruncated: true,
      agentsTruncated: false,
      viewer: { identity, role: 'owner' as const, permissions: { send: true, manage: true } },
      watchFilters: [],
    };
    expect(isWorkspaceView(workspace)).toBe(true);
    expect(isWorkspaceView({ ...workspace, peopleTotal: undefined })).toBe(true);
    expect(isWorkspaceView({ ...workspace, agentTotal: undefined })).toBe(true);
    expect(isWorkspaceView({ ...workspace, peopleTotal: undefined, agentTotal: undefined })).toBe(
      true,
    );
    expect(readWorkspaceView({ ...workspace, peopleTotal: '21' })?.peopleTotal).toBeUndefined();
    expect(
      isWorkspaceMemberListView({
        members: [],
        agents: [],
        grants: [
          {
            grantId: 'grant-1',
            kind: 'repository',
            target: 'beeline-work/beeline',
            reason: 'ship the profile pass',
            status: 'approved',
            requestedBy: identity,
            roomId: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
            createdAt: 1,
            auto: false,
            agent: { pubkey: 'c'.repeat(64), kind: 'agent', name: 'Bee' },
          },
        ],
        peopleTotal: 21,
        agentTotal: 0,
        membersTruncated: true,
        agentsTruncated: false,
      }),
    ).toBe(true);
    expect(
      isWorkspaceMemberListView({
        members: [],
        agents: [],
        membersTruncated: true,
        agentsTruncated: false,
      }),
    ).toBe(true);
    expect(
      isWorkspaceMemberListView({
        members: Array.from({ length: WORKSPACE_MEMBER_PAGE_SIZE + 1 }, () => ({
          identity,
          role: 'member' as const,
        })),
        agents: [],
        peopleTotal: WORKSPACE_MEMBER_PAGE_SIZE + 1,
        agentTotal: 0,
        membersTruncated: true,
        agentsTruncated: false,
      }),
    ).toBe(true);
    expectTypeOf<PhoneOperationMap['uploadMedia']['output']>().toHaveProperty('url');
    expectTypeOf<PhoneOperationMap['sendRoomMessage']['input']>().toHaveProperty('messageId');
    expectTypeOf<PhoneOperationMap['sendRoomMessage']['output']>().toHaveProperty(
      'activeSteerAgentIds',
    );
    expectTypeOf<PhoneOperationMap['setMessageBookmark']['input']>().toHaveProperty('bookmarked');
    expectTypeOf<PhoneOperationMap['deleteRoomMessage']['input']>().toHaveProperty('messageId');
    expectTypeOf<PhoneOperationMap['listMessageBookmarks']['output']>().toHaveProperty('bookmarks');
    expectTypeOf<PhoneOperationMap['readNeedsYou']['output']>().toHaveProperty('items');
    expectTypeOf<PhoneOperationMap['countNeedsYou']['output']>().toHaveProperty('count');
    expectTypeOf<PhoneOperationMap['clearNeedsYou']['input']>().toHaveProperty('messageId');
    expectTypeOf<PhoneOperationMap['addWorkspaceMember']['input']>().toHaveProperty('role');
    expectTypeOf<PhoneOperationMap['createRoomSchedule']['input']>().toHaveProperty('cadence');
    expectTypeOf<PhoneOperationMap['approveCornerMerge']['input']>().toHaveProperty('cornerId');
    expectTypeOf<PhoneOperationMap['listRoomWorkflows']['output']>().toHaveProperty(
      'defaultBranch',
    );
    expectTypeOf<PhoneOperationMap['dispatchRoomWorkflow']['input']>().toHaveProperty(
      'workflowName',
    );
    expectTypeOf<PhoneOperationMap['answerChoice']['input']>().toHaveProperty('optionId');
    expectTypeOf<PhoneOperationMap['skipChoice']['input']>().toHaveProperty('choiceId');
    expectTypeOf<PhoneOperationMap['acceptConnectorOffer']['input']>().toHaveProperty('offerId');
    expectTypeOf<PhoneOperationMap['requestCornerClose']['input']>().toHaveProperty('roomId');
    expectTypeOf<PhoneOperationMap['closeChat']['input']>().toHaveProperty('roomId');
    expectTypeOf<PhoneOperationMap['reopenChat']['input']>().toHaveProperty('roomId');
    expectTypeOf<PhoneOperationMap['listRoomSchedules']['output']>().toHaveProperty('schedules');
    expectTypeOf<PhoneOperationMap['updateIdentityPushLevel']['input']>().toHaveProperty(
      'pushLevel',
    );
    expectTypeOf<PhoneOperationMap['getManagedIdentity']['output']>().toHaveProperty('pushLevel');
    expect(isPushLevel('mine')).toBe(true);
  });

  it('accepts only the server-owned four-state corner contract', () => {
    const header = {
      id: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
      workspaceId: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb',
      name: 'Launch',
      archived: false,
      createdAt: 1,
      updatedAt: 2,
    };
    const base = {
      room: header,
      viewer: { identity, role: 'owner', permissions: { send: true, manage: true } },
      watchFilters: [],
    };
    const cornersFor = (corner: Record<string, unknown>) =>
      readCornerListView({ ...base, corners: [corner] })?.corners;
    const lifecycle = { lifecycle: 'unknown', checks: 'unknown' };

    for (const state of ['working', 'waiting', 'review', 'archived'] as const) {
      expect(cornersFor({ corner: header, lifecycle, state, initiator: identity })).toEqual([
        { corner: header, lifecycle, state, initiator: identity },
      ]);
    }
    // The four retired state words are not the contract: the corner is dropped,
    // and the list it sits in survives.
    for (const state of ['open', 'idle', 'concluded', 'closed']) {
      expect(cornersFor({ corner: header, lifecycle, state })).toEqual([]);
    }
    // A malformed or non-human initiator is omitted; the corner itself stays.
    expect(
      cornersFor({
        corner: header,
        lifecycle,
        state: 'working',
        initiator: { pubkey: 'missing identity fields' },
      }),
    ).toEqual([{ corner: header, lifecycle, state: 'working' }]);
    expect(
      cornersFor({
        corner: header,
        lifecycle,
        state: 'working',
        initiator: { ...identity, kind: 'agent' },
      }),
    ).toEqual([{ corner: header, lifecycle, state: 'working' }]);
    // Only a literal true marks the corner as awaiting the viewer.
    expect(cornersFor({ corner: header, lifecycle, state: 'waiting', awaitsViewer: true })).toEqual(
      [{ corner: header, lifecycle, state: 'waiting', awaitsViewer: true }],
    );
    expect(
      cornersFor({ corner: header, lifecycle, state: 'waiting', awaitsViewer: 'yes' }),
    ).toEqual([{ corner: header, lifecycle, state: 'waiting' }]);
    // A lifecycle word this bundle does not know reads as unknown rather than
    // dropping the corner out of the list.
    expect(
      cornersFor({
        corner: header,
        lifecycle: { lifecycle: 'APPROVED', checks: 'flaky' },
        state: 'review',
      }),
    ).toEqual([{ corner: header, lifecycle, state: 'review' }]);
    // The archived list's closure stamp travels; an unreadable one is dropped
    // rather than dating the closure from the epoch.
    expect(
      cornersFor({ corner: header, lifecycle, state: 'archived', closedAt: 1_700_000_000 }),
    ).toEqual([{ corner: header, lifecycle, state: 'archived', closedAt: 1_700_000_000 }]);
    expect(cornersFor({ corner: header, lifecycle, state: 'archived', closedAt: 'never' })).toEqual(
      [{ corner: header, lifecycle, state: 'archived' }],
    );
  });

  it('owns the canonical invite-token format while accepting pre-contract monolith tokens', () => {
    const token = createCommunityInviteToken(Uint8Array.from({ length: 32 }, (_, index) => index));
    expect(token).toBe('inv_000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f');
    expect(isCommunityInviteToken(token)).toBe(true);
    expect(isCommunityInviteToken(`bzi_${'a'.repeat(64)}`)).toBe(true);
    expect(isCommunityInviteToken(`bzi_${'A'.repeat(42)}_`)).toBe(true);
    expect(isCommunityInviteToken(`bzi_${'a'.repeat(63)}`)).toBe(false);
  });

  it('accepts the authenticated membership hint on invite previews', () => {
    const invite = { name: 'Builders', expiresAt: 2_000_000_000 };
    expect(isInviteView(invite)).toBe(true);
    expect(
      readInviteView({
        ...invite,
        joinedWorkspaceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      })?.joinedWorkspaceId,
    ).toBe('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    expect(
      readInviteView({ ...invite, joinedWorkspaceId: false })?.joinedWorkspaceId,
    ).toBeUndefined();
  });

  it('reads the inviter and Workspace size on invite previews, dropping unreadable parts', () => {
    const invite = { name: 'Builders', expiresAt: 2_000_000_000 };
    expect(
      readInviteView({
        ...invite,
        inviter: { name: 'Mara', handle: 'mara', face: 'fox', role: 'owner' },
        memberCount: 8,
        agentCount: 4,
      }),
    ).toEqual({
      ...invite,
      inviter: { name: 'Mara', handle: 'mara', face: 'fox', role: 'owner' },
      memberCount: 8,
      agentCount: 4,
    });
    expect(
      readInviteView({
        ...invite,
        inviter: { name: 'Mara', role: 'emperor', handle: 7 },
        memberCount: 'many',
      }),
    ).toEqual({ ...invite, inviter: { name: 'Mara' } });
    expect(readInviteView({ ...invite, inviter: { handle: 'mara' } })).toEqual(invite);
  });

  it('owns the prefix-free agent pairing-code format while accepting unexpired legacy codes', () => {
    const code = createAgentPairingCode(Uint8Array.from({ length: 8 }, (_, index) => index));
    expect(code).toBe('00010203-04050607');
    expect(isAgentPairingCode(code)).toBe(true);
    expect(isAgentPairingCode('BUZZ-1234ABCD-5678EF90')).toBe(true);
    expect(isAgentPairingCode('BUZZ-4S4P-ZPJP')).toBe(true);
    expect(isAgentPairingCode('BEE-1234ABCD-5678EF90')).toBe(false);
    expect(isAgentPairingCode('BUZZ-1111-1111')).toBe(false);
    expect(isAgentPairingCode('1234ABCD-5678EF9')).toBe(false);
    expect(normalizeAgentPairingCode('  1234abcd-5678ef90  ')).toBe('1234ABCD-5678EF90');
  });
});
