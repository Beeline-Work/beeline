import { WORKSPACE, VIEWER, OWNER, MEMBER, AGENT, state, liveListeners, roomView, phoneOperation, member, baseWorkspace, baseAgent, render, press, agentChanged, openAgentProfile, openAgentManagement, fixtureScope1 } from './test-support-members.test-support';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';

describe('Members workspace management', () => {
const scope1 = fixtureScope1();


  // The grants block was removed from this page: under yolo it read as an
  // approval queue, not the ledger it needed to be. Grants keep recording
  // server-side (agent_grants, including the auto marker) — see database.ts
  // and daemon-service.ts — but this page no longer surfaces them at all.
  it('renders no grants surface, even when the server has grants for this agent', async () => {
    state.agent = {
      ...baseAgent(),
      canManageGrants: true,
      grants: [
        {
          grantId: 'g-live',
          kind: 'command',
          target: 'fly deploy -a preview --with FLY_TOKEN',
          reason: 'publish the preview',
          status: 'approved',
          requestedBy: { pubkey: MEMBER, kind: 'human', name: 'Builder' },
          decidedBy: { pubkey: VIEWER, kind: 'human', name: 'Viewer' },
          roomId: '22222222-2222-4222-8222-222222222222',
        roomName: 'ship-the-slab',
          createdAt: 1_756_900_000,
          decidedAt: 1_756_900_060,
          auto: true,
        },
      ],
    };
    const renderer = await render();
    await openAgentManagement(renderer);

    expect(renderer.root.findAllByProps({ testID: 'agent-grants' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ testID: 'agent-grants-empty' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ testID: 'agent-grant-g-live-line' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ testID: 'agent-grant-g-live-revoke' })).toHaveLength(0);
  });


  it('keeps the true People total, pages the first screen, searches past it, and load-more appends', async () => {
    const extras = Array.from({ length: 21 }, (_, index) =>
      member(
        `e${String(index).padStart(63, '0')}`,
        `Zebra ${String(index).padStart(2, '0')}`,
        'member',
      ),
    );
    const allPeople = [
      member(VIEWER, 'Viewer', 'owner'),
      member(OWNER, 'Captain', 'owner'),
      member(MEMBER, 'Builder', 'member'),
      ...extras,
    ];
    const firstPage = allPeople.slice(0, 20);
    const offPage = extras[20]!;
    state.workspace = {
      ...baseWorkspace(),
      members: firstPage,
      peopleTotal: allPeople.length,
      agentTotal: 1,
      membersTruncated: true,
      agentsTruncated: false,
    };
    roomView.workspaceMembers.mockImplementation(async (_workspaceId: string, query: any = {}) => {
      const needle = String(query.q ?? '')
        .trim()
        .toLowerCase();
      const filtered = needle
        ? allPeople.filter(
            (item) =>
              item.identity.name.toLowerCase().includes(needle) ||
              item.identity.handle.includes(needle),
          )
        : allPeople;
      const offset = Number(query.offset ?? 0);
      const page = filtered.slice(offset, offset + 20);
      return {
        members: query.kind === 'agent' ? [] : page,
        agents: query.kind === 'human' ? [] : state.workspace.agents,
        peopleTotal: filtered.length,
        agentTotal: needle ? 0 : 1,
        membersTruncated: offset + page.length < filtered.length,
        agentsTruncated: false,
      };
    });

    const renderer = await render();
    expect(renderer.root.findByProps({ testID: 'members-people-head' }).props.count).toEqual(allPeople.length);
    expect(
      renderer.root.findAllByProps({ testID: `member-${firstPage[0]!.identity.pubkey}-identity` })
        .length,
    ).toBeGreaterThan(0);
    expect(
      renderer.root.findAllByProps({ testID: `member-${offPage.identity.pubkey}-identity` }),
    ).toHaveLength(0);

    await act(async () => {
      renderer.root
        .findByProps({ testID: 'members-search' })
        .props.onChangeText(offPage.identity.name);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(roomView.workspaceMembers).toHaveBeenCalledWith(
      WORKSPACE,
      expect.objectContaining({ q: offPage.identity.name }),
    );
    expect(
      renderer.root.findAllByProps({ testID: `member-${offPage.identity.pubkey}-identity` }).length,
    ).toBeGreaterThan(0);
    expect(renderer.root.findByProps({ testID: 'members-people-head' }).props.count).toEqual(1);

    await act(async () => {
      renderer.root.findByProps({ testID: 'members-search' }).props.onChangeText('');
      await Promise.resolve();
      await Promise.resolve();
    });
    const row = (pubkey: string) =>
      renderer.root.findAll(
        (node: any) =>
          node.type === 'Pressable' && node.props.testID === `member-${pubkey}-identity`,
      );
    const firstPageRows = firstPage.flatMap((item) => row(item.identity.pubkey)).length;
    await press(renderer, 'members-load-more-people');
    expect(roomView.workspaceMembers).toHaveBeenCalledWith(
      WORKSPACE,
      expect.objectContaining({ kind: 'human', offset: 20 }),
    );
    expect(row(offPage.identity.pubkey)).toHaveLength(1);
    expect(row(VIEWER)).toHaveLength(1);
    expect(firstPage.flatMap((item) => row(item.identity.pubkey))).toHaveLength(firstPageRows);
    expect(renderer.root.findByProps({ testID: 'members-people-head' }).props.count).toEqual(allPeople.length);
  });
});


it('refreshes an open profile from its plain read after a usage change', async () => {
  const renderer = await render(); await openAgentProfile(renderer);
  const before = roomView.agent.mock.calls.length;
  await act(async () => { for (const listener of liveListeners) listener({ monolithLive: {
    type: 'resource-change', roomId: '', resource: 'agent', resourceId: AGENT, usageOnly: true,
  } }); });
  expect(roomView.agent.mock.calls.length).toBe(before + 1);
  await agentChanged(); expect(roomView.agent.mock.calls.length).toBe(before + 2);
});


it('the existing Refresh usage action does not follow its receipt with a full Agent read', async () => {
  state.agent.usage = { updatedAt: 10, windows: [{ rateLimitType: 'five_hour', status: 'allowed', utilization: 0.14, updatedAt: 10 }] };
  const renderer = await render(); await openAgentProfile(renderer);
  const before = roomView.agent.mock.calls.length; phoneOperation.mockResolvedValueOnce({ status: 'fresh' });
  const refresh = renderer.root.findAllByType('Button' as any).find((node: any) => node.props.accessibilityLabel === 'Refresh usage');
  expect(refresh).toBeDefined();
  await act(async () => { await refresh!.props.onPress(); });
  expect(phoneOperation).toHaveBeenCalledWith('refreshAgentUsage', { workspaceId: WORKSPACE, agentId: AGENT }, expect.any(Object));
  expect(roomView.agent.mock.calls.length).toBe(before);
});
