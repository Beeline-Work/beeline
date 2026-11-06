import { WORKSPACE, VIEWER, OWNER, MEMBER, AGENT, state, roomView, share, modal, platform, client, phoneOperation, safeArea, chevronDirections, baseWorkspace, baseAgent, create, render, press, agentChanged, openAgentProfile, openAgentManagement, sheet, fixtureScope1 } from "../../../test/fixtures/members.test-support";
import { HumanProfile } from './human-profile';
import AgentProfileRoute from './agent-profile';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { router } from 'expo-router';



it('saves a webhook URL and key through the owner profile, clears the draft and can clear setup', async () => {
  state.agent.wake = { url: null, keySet: false };
  const renderer = await render();
  await openAgentProfile(renderer);
  const wakeRow = () => renderer.root.findAll((node: any) => node.props.title === 'Webhook URL' && node.props.actionControl)[0];
  await act(async () => wakeRow().props.actionControl.onPress());
  const field = (label: string) => renderer.root.findAll((node: any) => node.props.accessibilityLabel === label && node.props.onChangeText)[0];
  await act(async () => {
    field('Webhook URL').props.onChangeText('https://hooks.example/wake');
    field('Auth token').props.onChangeText('private-wake-key');
  });
  expect(field('Auth token').props.secureTextEntry).toBe(true);
  const actions = () => renderer.root.findAll((node: any) => Array.isArray(node.props.actions) && node.props.actions.some((a: any) => a.label === 'Save'))[0];
  await act(async () => { await actions().props.actions.find((a: any) => a.label === 'Save').onPress(); });
  expect(phoneOperation).toHaveBeenCalledWith('updateAgentWake', {
    workspaceId: WORKSPACE, agentId: AGENT, url: 'https://hooks.example/wake', key: 'private-wake-key',
  });
  expect(wakeRow().props.descriptionDetail).toBe('Auth token: set');
  await act(async () => wakeRow().props.actionControl.onPress());
  expect(field('Auth token').props.value).toBe('');
  const clear = renderer.root.findAll((node: any) => node.props.label === 'Clear webhook' && node.props.onPress)[0];
  await act(async () => { await clear.props.onPress(); });
  expect(phoneOperation).toHaveBeenLastCalledWith('updateAgentWake', { workspaceId: WORKSPACE, agentId: AGENT, url: '' });
  expect(wakeRow().props.descriptionDetail).toBe('Auth token: not set');
});

it('does not expose wake setup when the server omits owner-only wake configuration', async () => {
  const renderer = await render();
  await openAgentProfile(renderer);
  expect(renderer.root.findAll((node: any) => node.props.title === 'Webhook URL')).toHaveLength(0);
});
describe('Members workspace management', () => {
const scope1 = fixtureScope1();

  it('lets its last member scroll clear of the system navigation bar', async () => {
    safeArea.bottom = 48;
    try {
      const renderer = await render();
      const scroll = renderer.root.findByType('KeyboardAwareScrollView' as never);
      const contentStyle = Object.assign(
        {},
        ...[scroll.props.contentContainerStyle].flat(Infinity as 1),
      );
      expect(contentStyle.paddingBottom).toBe(48 + 48);
    } finally {
      safeArea.bottom = 0;
    }
  });


  it('lets an agent profile scroll its last row clear of the system navigation bar', async () => {
    safeArea.bottom = 48;
    try {
      const renderer = await render();
      await openAgentProfile(renderer);
      const scroll = renderer.root.findByProps({ testID: 'agent-profile-scroll' });
      const contentStyle = Object.assign(
        {},
        ...[scroll.props.contentContainerStyle].flat(Infinity as 1),
      );
      expect(contentStyle.paddingBottom).toBe(48 + 48);
    } finally {
      safeArea.bottom = 0;
    }
  });


  it('shows model on the agent row without spending the row on presence', async () => {
    const renderer = await render();
    const agentRow = renderer.root.findByProps({ testID: `agent-${AGENT}-identity` });
    const mark = agentRow.findByType('IdentityMark' as any);
    expect(mark.props.kind).toBe('agent');
    expect(mark.props.alive).toBeFalsy();
    expect(agentRow.findAllByType('Text' as any)[1].props.children).toBe('Sonnet');
    expect(
      agentRow
        .findAllByType('Text' as any)
        .flatMap((node: any) => node.props.children)
        .join(' '),
    ).not.toMatch(/online|offline/i);
  });


  it('shares a real Workspace invite directly from the PEOPLE section head +', async () => {
    const renderer = await render();
    expect(sheet(renderer).props.visible).toBe(false);
    // No Room is in scope here: the sheet carries only the Workspace-level ways in.
    expect(sheet(renderer).props.candidates).toBeUndefined();
    await press(renderer, 'members-add-people');

    expect(client.createInvite).toHaveBeenCalledWith(WORKSPACE);
    expect(share).toHaveBeenCalledWith({
      message: `https://usebeeline.app/join/inv_${'e'.repeat(64)}`,
    });
    expect(sheet(renderer).props.visible).toBe(false);
    expect(renderer.root.findAllByProps({ testID: 'invite-person' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ testID: 'invite-agent' })).toHaveLength(0);
  });


  it('opens the pairing sheet directly from the AGENTS section head +', async () => {
    const renderer = await render();
    expect(sheet(renderer).props.visible).toBe(false);
    await press(renderer, 'members-add-agents');
    expect(sheet(renderer).props.visible).toBe(true);
    expect(sheet(renderer).props.agentConnectOnly).toBe(true);
    expect(client.createAgentPairingCode).toHaveBeenCalledWith(WORKSPACE);
  });


  it('lets a non-manager add their own agent but not invite people', async () => {
    state.workspace = {
      ...baseWorkspace(),
      viewer: {
        ...baseWorkspace().viewer,
        role: 'member',
        permissions: { send: true, manage: false },
      },
    };
    const renderer = await render();
    expect(renderer.root.findAllByProps({ testID: 'members-add-people' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ testID: 'members-add-agents' }).length).toBeGreaterThan(
      0,
    );
    expect(renderer.root.findAllByProps({ testID: 'add-members' })).toHaveLength(0);
    expect(renderer.root.findAllByType('Button' as any)).toHaveLength(0);
  });


  it('names the action and the kind on each section head +, with a 44pt hit area', async () => {
    const renderer = await render();
    const people = renderer.root.findByProps({ testID: 'members-add-people' });
    const agents = renderer.root.findByProps({ testID: 'members-add-agents' });
    expect(people.props.accessibilityLabel).toBe('Add people');
    expect(agents.props.accessibilityLabel).toBe('Add agents');
    {
      const box = people.findAllByType('Pressable').at(-1)!.props.style({ pressed: false })[0];
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.width).toBeGreaterThanOrEqual(44);
    }
    {
      const box = agents.findAllByType('Pressable').at(-1)!.props.style({ pressed: false })[0];
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.width).toBeGreaterThanOrEqual(44);
    }
  });


  it('shows People and Agents without a count when the server omits totals', async () => {
    const { peopleTotal: _people, agentTotal: _agents, ...legacy } = baseWorkspace();
    state.workspace = legacy;
    roomView.workspaceMembers.mockImplementation(async () => ({
      members: legacy.members,
      agents: legacy.agents,
      membersTruncated: false,
      agentsTruncated: false,
    }));
    const renderer = await render();
    expect(renderer.root.findByProps({ testID: 'members-people-head' }).props.title).toBe(
      'People',
    );
    expect(renderer.root.findByProps({ testID: 'members-agents-head' }).props.title).toBe(
      'Agents',
    );
    expect(renderer.root.findByProps({ testID: `member-${MEMBER}-identity` })).toBeDefined();
    expect(renderer.root.findByProps({ testID: `agent-${AGENT}-identity` })).toBeDefined();

    await act(async () => {
      renderer.root.findByProps({ testID: 'members-search' }).props.onChangeText('Builder');
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(renderer.root.findByProps({ testID: 'members-people-head' }).props.title).toBe(
      'People',
    );
    expect(renderer.root.findByProps({ testID: `member-${MEMBER}-identity` })).toBeDefined();
  });


  it('shows the word alone over counted section heads and no loose total (C73, C79)', async () => {
    const renderer = await render();
    expect(renderer.root.findByProps({ testID: 'members-title' }).props.children).toBe('Members');
    expect(renderer.root.findByProps({ testID: 'members-people-head' }).props.count).toEqual(3);
    expect(renderer.root.findByProps({ testID: 'members-agents-head' }).props.count).toEqual(1);
    const surface = renderer.root.findByProps({ testID: 'workspace-members-surface' });
    const texts = surface.findAllByType('Text' as any).map((node: any) => node.props.children);
    expect(texts).not.toContain(4);
    expect(texts.flat().join(' ')).not.toMatch(/⌬|ONLINE|OFFLINE|MEMBER\b/);
  });


  it('shows every handle once with a role under a human and model and owner on an agent', async () => {
    const renderer = await render();
    const agentRow = renderer.root.findByProps({ testID: `agent-${AGENT}-identity` });
    const agentTexts = agentRow
      .findAllByType('Text' as any)
      .map((node: any) => node.props.children);
    expect(agentTexts).toEqual(['@clara', 'Sonnet', '@viewer']);
    expect(chevronDirections(agentRow)).toEqual(['right']);
    expect(agentRow.findByType('IdentityMark' as any).props.alive).toBeFalsy();
    const personRow = renderer.root.findByProps({ testID: `member-${MEMBER}-identity` });
    expect(personRow.findAllByType('Text' as any).map((node: any) => node.props.children)).toEqual([
      '@builder',
      'member',
    ]);
    expect(chevronDirections(personRow)).toEqual(['right']);
    // The viewer can open their own profile too.
    const selfRow = renderer.root.findByProps({ testID: `member-${VIEWER}-identity` });
    expect(selfRow.props.disabled).toBe(false);
    expect(selfRow.findAllByType('Text' as any).map((node: any) => node.props.children)).toEqual([
      '@viewer',
      'owner',
    ]);
    expect(chevronDirections(selfRow)).toEqual(['right']);
  });


  it('shows the connected owner on the agent profile', async () => {
    const renderer = await render();
    await openAgentManagement(renderer);
    expect(
      renderer.root
        .findByProps({ testID: 'profile-owner' })
        .findAllByType('Text')
        .flatMap((node: any) => node.children)
        .filter((child: any) => typeof child === 'string')
        .join(''),
    ).toContain('viewer');
  });


  it('omits a handleless owner from the agent row and profile', async () => {
    const owner = { pubkey: VIEWER, kind: 'human' as const, name: 'Viewer' };
    state.workspace = {
      ...baseWorkspace(),
      agents: [{ ...baseWorkspace().agents[0], owner }],
    };
    state.agent = { ...baseAgent(), owner };
    const renderer = await render();
    const agentRow = renderer.root.findByProps({ testID: `agent-${AGENT}-identity` });
    expect(agentRow.findAllByType('Text' as any).map((node: any) => node.props.children)).toEqual([
      '@clara',
      'Sonnet',
    ]);
    expect(chevronDirections(agentRow)).toEqual(['right']);

    await openAgentManagement(renderer);
    expect(renderer.root.findAllByProps({ testID: 'agent-owner' })).toHaveLength(0);
  });


  it('opens a person profile from the roster without opening a DM', async () => {
    const renderer = await render();
    await press(renderer, `member-${MEMBER}-identity`);
    const { router } = await import('expo-router');
    expect(router.push).toHaveBeenCalledWith({
      pathname: '/beeline/human-profile',
      params: { communityId: WORKSPACE, memberId: MEMBER },
    });
    expect(client.resolveDirectMessage).not.toHaveBeenCalled();
  });


  it('opens a human profile on Android when window has no browser event API', async () => {
    platform.OS = 'android';
    vi.stubGlobal('window', {});
    try {
      const renderer = await scope1.personProfile();
      expect(renderer.root.findByProps({ testID: 'human-profile' })).toBeDefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });


  it('opens an agent profile on Android when window has no browser event API', async () => {
    platform.OS = 'android';
    vi.stubGlobal('window', {});
    try {
      let renderer!: ReactTestRenderer;
      await act(async () => {
        renderer = create(<AgentProfileRoute />);
      });
      expect(renderer.root.findByProps({ testID: 'agent-profile' })).toBeDefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });


  it('Reproduction 2315-R3: rendered profile keeps live identity after saving role', async () => {
    const renderer = await scope1.personProfile();
    const identities = await import('@/buzz/identity-records');
    const records = await import('@/buzz/workspace-records');
    const { nextSurfaceStamp } = await import('@/buzz/surface-clock');
    const { ProfileIdentity } = await import('@/components/buzz/ProfileIdentity');
    await act(async () => {
      identities.recordPerson(identities.identityScope('https://relay.test', VIEWER),
        {...state.workspace.members.find((row: any) => row.identity.pubkey === MEMBER).identity, name: 'Builder Renamed'}, nextSurfaceStamp());
    });
    expect(renderer.root.findByType(ProfileIdentity).props.identity.name).toBe('Builder Renamed');
    await press(renderer, 'edit-person-role');
    await press(renderer, 'person-role-admin');
    await press(renderer, 'save-person-role');
    const shown = renderer.root.findByType(ProfileIdentity).props;
    console.log('Reproduction 2315-R3 rendered profile after Save:', shown.identity.name, shown.role);
    expect(shown.identity.name).toBe('Builder Renamed');
    expect(shown.role).toBe('admin');
  });


  it('saves role edits from the human profile and supports cancel', async () => {
    const renderer = await scope1.personProfile();
    expect(roomView.workspace).not.toHaveBeenCalled(); // R12c
    await press(renderer, 'edit-person-role');
    await press(renderer, 'person-role-admin');
    expect(phoneOperation).not.toHaveBeenCalled();
    await press(renderer, 'save-person-role');
    expect(phoneOperation).toHaveBeenCalledWith('addWorkspaceMember', {
      workspaceId: WORKSPACE,
      memberId: MEMBER,
      role: 'admin',
    });
    expect(renderer.root.findAllByProps({ testID: 'person-role-editor' })).toHaveLength(0);
  });


  it('shows the profiled member grants as a read-only ledger row that discloses its detail', async () => {
    state.workspace = {
      ...state.workspace,
      managerSettings: {
        visibility: 'invite-only',
        rooms: [
          {
            id: '22222222-2222-4222-8222-222222222222',
            name: 'ship-the-slab',
            visibility: 'public',
            createdAt: 1,
          },
        ],
      },
    };
    const renderer = await scope1.personProfile();
    const head = renderer.root.findByProps({ testID: 'member-grant-member-grant' });
    expect(head.props.title).toBe('beeline-work/beeline');
    // The agent's stated reason sits on its own line, then the provenance line.
    expect(head.props.description).toBe('ship the profile pass');
    expect(head.props.descriptionDetail).toContain('approved by Viewer,');
    expect(head.props.descriptionDetail).toContain('· standing');
    // A disclosure, never a decision: nothing is written from this row.
    expect(
      renderer.root.findAllByProps({ testID: 'member-grant-member-grant-details' }),
    ).toHaveLength(0);
    await press(renderer, 'member-grant-member-grant');
    const detail = renderer.root.findByProps({ testID: 'member-grant-member-grant-details' });
    const lines = detail
      .findAllByType('Text' as any)
      .map((node: any) => String(node.props.children));
    expect(lines).toContain('Requested by Builder');
    expect(lines).toContain('Room ship-the-slab');
    expect(roomView.workspace).not.toHaveBeenCalled();
    console.log('R12c Demonstrated: human profile shows role edit and Room ship-the-slab; zero Workspace reads.');
    expect(phoneOperation).not.toHaveBeenCalled();
  });


  it('Reproduction 2315-R4: live socket grant event refreshes the rendered profile', async () => {
    const { LiveConnection } = await vi.importActual<any>('@/sync/transport/live-connection');
    let socket: any;
    class TestSocket {
      readyState = 0;
      sent: string[] = [];
      onopen?: () => void;
      onmessage?: (event: {data: string}) => void;
      constructor() { socket = this; }
      send(value: string) { this.sent.push(value); }
      close() { this.readyState = 3; }
    }
    vi.stubGlobal('WebSocket', TestSocket);
    const connection = new LiveConnection({
      authorization: async () => 'test-session', liveUrl: () => 'wss://test.invalid/live',
      recordScope: async () => undefined,
      subscribeIdentityChange: () => () => {},
    });
    (client.surfaceSubscribe as any).mockImplementation((filters: any, listener: any) => connection.register(filters, listener));
    try {
      await render();
      const renderer = await scope1.personProfile();
      socket.readyState = 1;
      socket.onopen();
      const first = await roomView.workspaceMembers.mock.results[0]!.value as any;
      roomView.workspaceMembers.mockImplementation(async () => ({
        ...first, grants: [{...first.grants[0], grantId: 'updated-room-grant', target: 'new/target'}],
      }));
      await act(async () => {
        socket.onmessage({data: JSON.stringify({type: 'invalidate', roomId: first.grants[0].roomId, reason: 'postgres:agent_grants'})});
      });
      console.log('Reproduction 2315-R4 subscribe frames:', socket.sent);
      console.log('Reproduction 2315-R4 profile reads after socket grant event:', roomView.workspaceMembers.mock.calls.length);
      expect(renderer.root.findAll((node: any) =>
        typeof node.type === 'string' && node.props.testID === 'member-grant-updated-room-grant')).toHaveLength(1);
    } finally {
      connection.dispose();
      vi.unstubAllGlobals();
    }
  });


  it('refreshes the profile grants live with one read per relay signal, on the watch Members shares (J27)', async () => {
    const list = await render();
    const renderer = await scope1.personProfile();
    // Members and the profile hold one relay watch for this Workspace: the
    // profile's grant Room joins the managed Room on the same subscription.
    const subscribes = client.surfaceSubscribe.mock.calls as unknown as [any, (event?: unknown) => void][];
    expect(subscribes.at(-1)![0]).toEqual([{ kinds: [0, 9, 9000, 9001],
      '#h': ['22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333'] }]);
    expect(subscribes).toHaveLength(3);
    expect(roomView.workspaceMembers).toHaveBeenCalledTimes(1);
    expect(roomView.workspaceMembers).toHaveBeenCalledWith(WORKSPACE, { memberId: MEMBER });
    const ownedAgent = state.workspace.agents[0];
    const first = (await roomView.workspaceMembers.mock.results[0]!.value) as any;
    roomView.workspaceMembers.mockImplementation(async () => ({
      ...first,
      agents: [ownedAgent],
      grants: [{ ...first.grants[0], grantId: 'live-grant', target: 'beeline-work/live' }],
    }));
    const signal = subscribes.at(-1)![1];
    await act(async () => signal({ monolithLive: { type: 'invalidate', roomId: '', reason: 'postgres:memberships' } } as never));
    expect(roomView.workspaceMembers).toHaveBeenCalledTimes(2);
    expect(renderer.root.findByProps({ testID: 'member-grant-live-grant' }).props.title)
      .toBe('beeline-work/live');
    list.unmount();
  });


  it('Reproduction 2315-R6: a complete refresh without the owned agent drops it from the rendered profile', async () => {
    const owned = {
      ...state.workspace.agents[0],
      owner: { pubkey: MEMBER, kind: 'human', name: 'Builder', handle: 'builder' },
    };
    state.workspace = { ...state.workspace, agents: [owned] };
    const base = roomView.workspaceMembers.getMockImplementation()!;
    roomView.workspaceMembers.mockImplementation(async (...args: any[]) => ({
      ...(await (base as any)(...args)), agents: [owned], agentsTruncated: false,
    }));
    const list = await render();
    const renderer = await scope1.personProfile();
    const shown = () => renderer.root.findAll((node: any) =>
      node.props.title === '@clara').length;
    expect(shown()).toBeGreaterThan(0);
    roomView.workspaceMembers.mockImplementation(async (...args: any[]) => ({
      ...(await (base as any)(...args)), agents: [], agentsTruncated: false,
    }));
    const subscribes = client.surfaceSubscribe.mock.calls as unknown as [any, (event?: unknown) => void][];
    await act(async () => subscribes.at(-1)![1]({ monolithLive: { type: 'invalidate', roomId: '', reason: 'postgres:memberships' } } as never));
    expect(shown()).toBe(0);
    list.unmount();
  });


  it('keeps an owned agent a truncated profile refresh only leaves out', async () => {
    const owned = {
      ...state.workspace.agents[0],
      owner: { pubkey: MEMBER, kind: 'human', name: 'Builder', handle: 'builder' },
    };
    state.workspace = { ...state.workspace, agents: [owned] };
    const base = roomView.workspaceMembers.getMockImplementation()!;
    roomView.workspaceMembers.mockImplementation(async (...args: any[]) => ({
      ...(await (base as any)(...args)), agents: [owned], agentsTruncated: false,
    }));
    const list = await render();
    const renderer = await scope1.personProfile();
    roomView.workspaceMembers.mockImplementation(async (...args: any[]) => ({
      ...(await (base as any)(...args)), agents: [], agentsTruncated: true,
    }));
    const subscribes = client.surfaceSubscribe.mock.calls as unknown as [any, (event?: unknown) => void][];
    await act(async () => subscribes.at(-1)![1]({ monolithLive: { type: 'invalidate', roomId: '', reason: 'postgres:memberships' } } as never));
    expect(renderer.root.findAll((node: any) =>
      node.props.title === '@clara').length).toBeGreaterThan(0);
    list.unmount();
  });


  it('Reproduction 2315-R7: unlinking ownership preserves the live agent identity in rendered Members', async () => {
    const owned = {
      ...state.workspace.agents[0],
      owner: { pubkey: MEMBER, kind: 'human', name: 'Builder', handle: 'builder' },
    };
    state.workspace = { ...state.workspace, agents: [owned] };
    const base = roomView.workspaceMembers.getMockImplementation()!;
    roomView.workspaceMembers.mockImplementation(async (...args: any[]) => ({
      ...(await (base as any)(...args)), agents: [owned], agentsTruncated: false,
    }));
    const list = await render();
    await scope1.personProfile();
    const identities = await import('@/buzz/identity-records');
    const records = await import('@/buzz/workspace-records');
    const { nextSurfaceStamp } = await import('@/buzz/surface-clock');
    const { mobileSurfaceCache, surfaceAddress } = await import('@/buzz/surface-storage');
    const { isWorkspaceMemberListView } = await import('@beeline/buzz-client');
    await act(async () => {
      identities.recordPerson(
        identities.identityScope('https://relay.test', VIEWER),
        { ...owned.identity, name: 'Clara Renamed', handle: 'renamedagent' },
        nextSurfaceStamp(),
      );
    });
    const shown = () => list.root.findAll((node: any) => node.props.name === 'Clara Renamed').length;
    expect(shown()).toBeGreaterThan(0);
    const first = await roomView.workspaceMembers.mock.results[0]!.value as any;
    await act(async () => {
      await mobileSurfaceCache.write(
        surfaceAddress('https://relay.test', VIEWER, '/workspace/:id/members/:memberId', {
          workspaceId: WORKSPACE, memberId: MEMBER,
        }),
        { ...first, agents: [], agentsTruncated: false },
        isWorkspaceMemberListView,
      );
    });
    expect(shown()).toBeGreaterThan(0);
    list.unmount();
  });


  it('keeps peers and owners outside admin role edit authority', async () => {
    state.workspace = baseWorkspace('admin');
    let renderer = await scope1.personProfile(OWNER);
    expect(renderer.root.findAllByProps({ testID: 'edit-person-role' })).toHaveLength(0);
    state.workspace.members = state.workspace.members.map((m: any) =>
      m.identity.pubkey === MEMBER ? { ...m, role: 'admin' } : m,
    );
    renderer = await scope1.personProfile();
    expect(renderer.root.findAllByProps({ testID: 'edit-person-role' })).toHaveLength(0);
  });


  it('lists members without any Banned members roster (banning UI removed)', async () => {
    const renderer = await render();
    // No "Banned members" disclosure, no lift controls, no ban operation call.
    expect(renderer.root.findAllByProps({ title: 'Banned members' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ testID: 'workspace-bans' })).toHaveLength(0);
    expect(phoneOperation).not.toHaveBeenCalledWith('listWorkspaceBans', expect.anything());
  });


  it('offers role edits without any ban control (banning UI removed)', async () => {
    const renderer = await scope1.personProfile();
    expect(renderer.root.findAllByProps({ testID: 'ban-person' })).toHaveLength(0);
    await press(renderer, 'edit-person-role');
    // Edit mode still renders Save; the Ban from Workspace row is gone.
    expect(renderer.root.findByProps({ testID: 'save-person-role' })).toBeDefined();
    expect(renderer.root.findAllByProps({ testID: 'ban-person' })).toHaveLength(0);
    expect(phoneOperation).not.toHaveBeenCalledWith('banWorkspaceMember', expect.anything());
  });


  it('removes a person from the Workspace through the same compact control as agents', async () => {
    const onClose = vi.fn();
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <HumanProfile workspaceId={WORKSPACE} memberId={MEMBER} onClose={onClose} />,
      );
    });
    await press(renderer, 'edit-person-role');
    const control = renderer.root.findByProps({ testID: 'remove-person' });
    expect(control.props.accessibilityLabel).toBe('Remove from Workspace');
    await press(renderer, 'remove-person');
    expect(modal.confirm).toHaveBeenCalledWith(
      'Remove Builder?',
      expect.any(String),
      expect.objectContaining({ destructive: true }),
    );
    expect(phoneOperation).toHaveBeenCalledWith('removeWorkspaceMember', {
      workspaceId: WORKSPACE,
      memberId: MEMBER,
    });
    expect(onClose).toHaveBeenCalled();
  });


  it('skips the remove control when the viewer declines the confirm dialog', async () => {
    modal.confirm.mockResolvedValueOnce(false);
    const renderer = await scope1.personProfile();
    await press(renderer, 'edit-person-role');
    await press(renderer, 'remove-person');
    expect(phoneOperation).not.toHaveBeenCalledWith('removeWorkspaceMember', expect.anything());
  });


  it('lets members view a human profile and message without management powers', async () => {
    state.workspace.viewer = {
      ...state.workspace.viewer,
      role: 'member',
      permissions: { send: true, manage: false },
    };
    const renderer = await scope1.personProfile();
    expect(renderer.root.findAllByProps({ testID: 'edit-person-role' })).toHaveLength(0);
    phoneOperation.mockResolvedValueOnce({ id: 'dm-room' });
    await press(renderer, 'human-profile-message');
    expect(phoneOperation).toHaveBeenCalledWith('resolveDirectMessage', {
      workspaceId: WORKSPACE,
      participantId: MEMBER,
    });
  });


  it('keeps human profile mutation failures visible for retry', async () => {
    const renderer = await scope1.personProfile();
    phoneOperation.mockRejectedValueOnce(new Error('network unavailable'));
    await press(renderer, 'human-profile-message');
    expect(
      renderer.root
        .findAllByType('Text' as any)
        .some((node: any) => String(node.props.children).includes('Could not complete request')),
    ).toBe(true);
  });


  it('renders MODEL and EFFORT rows with the live catalog as a typeahead chooser', async () => {
    const renderer = await render();
    await openAgentManagement(renderer);

    expect(renderer.root.findAllByProps({ testID: 'model-axis-mode' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ testID: 'model-config-activation-note' })).toHaveLength(
      0,
    );
    expect(renderer.root.findAllByProps({ testID: 'model-catalog-missing' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ testID: 'model-applies-model' })).toHaveLength(0);
    await press(renderer, 'model-axis-effort');
    expect(renderer.root.findAllByProps({ testID: 'model-option-effort-xhigh' })).toHaveLength(0);
    await press(renderer, 'model-option-effort-high');
    expect(client.setAgentModelConfig).toHaveBeenCalledWith(WORKSPACE, AGENT, { effort: 'high' });
    expect(renderer.root.findByProps({ testID: 'model-applies-effort' }).props.children).toBe(
      'Applies at the next session',
    );

    await press(renderer, 'model-axis-model');
    const options = renderer.root.findByProps({ testID: 'model-options-model' });
    expect(options.props.visible).toBe(true);
    expect(options.props.title).toBe('Model');
    expect(options.props.footer).toBeDefined();
    await act(async () => {
      renderer.root.findByProps({ testID: 'model-search-model' }).props.onChangeText('opu');
    });
    expect(renderer.root.findByProps({ testID: 'model-option-model-opus' })).toBeDefined();
    expect(renderer.root.findAllByProps({ testID: 'model-option-model-sonnet' })).toHaveLength(0);
    await press(renderer, 'model-option-model-opus');
    expect(client.setAgentModelConfig).toHaveBeenCalledWith(WORKSPACE, AGENT, {
      model: 'opus',
      effort: null,
    });
    expect(renderer.root.findByProps({ testID: 'model-options-model' }).props.visible).toBe(false);
    // After a model switch the row requests that model's live effort catalog.
    await press(renderer, 'model-axis-effort');
    await agentChanged();
    expect(renderer.root.findAllByProps({ testID: 'model-option-effort-high' })).toHaveLength(0);
    expect(renderer.root.findByProps({ testID: 'model-option-effort-xhigh' })).toBeDefined();
    expect(client.refreshAgentModelCatalog).toHaveBeenCalledWith(WORKSPACE, AGENT);
  });


  it('offers Fast mode only to the owner when the live catalog advertises it', async () => {
    state.agent.catalog.push({
      id: 'fast-mode',
      category: 'model_config',
      currentValue: 'off',
      options: [{ id: 'off' }, { id: 'on' }],
    });
    state.agent.fastMode = false;
    const renderer = await render();
    await openAgentManagement(renderer);
    expect(renderer.root.findByProps({ testID: 'fast-mode-setting' })).toBeDefined();
    await act(async () => renderer.root.findByProps({ testID: 'fast-mode-setting' }).props.toggle.onValueChange(true));
    expect(client.setAgentModelConfig).toHaveBeenCalledWith(WORKSPACE, AGENT, { fastMode: true });
    await act(async () => renderer.root.findByProps({ testID: 'fast-mode-setting' }).props.toggle.onValueChange(false));
    expect(client.setAgentModelConfig).toHaveBeenCalledWith(WORKSPACE, AGENT, { fastMode: false });
    state.agent = {
      ...state.agent,
      catalog: state.agent.catalog.filter((axis: any) => axis.id !== 'fast-mode'),
    };
    const { mobileSurfaceCache, surfaceAddress } = await import('@/buzz/surface-storage');
    await act(async () => mobileSurfaceCache.write(
      surfaceAddress('https://relay.test', VIEWER, '/workspace/:id/agents/:agentId',
        { workspaceId: WORKSPACE, agentPubkey: AGENT }), state.agent,
      (value: unknown): value is typeof state.agent => Boolean(value)));
    const unsupported = await render();
    await openAgentManagement(unsupported);
    expect(unsupported.root.findAllByProps({ testID: 'fast-mode-setting' })).toHaveLength(0);
  });


  it('keeps the catalog default effort atomically when selecting its live model', async () => {
    state.agent = {
      ...baseAgent(),
      catalog: [
        {
          id: 'model',
          category: 'model',
          currentValue: 'opus',
          options: [{ id: 'sonnet' }, { id: 'opus' }],
        },
        {
          id: 'effort',
          category: 'reasoning_effort',
          currentValue: 'high',
          options: [{ id: 'low' }, { id: 'high' }],
        },
      ],
      selected: { model: 'sonnet', effort: 'low' },
    };
    const renderer = await render();
    await openAgentManagement(renderer);
    await press(renderer, 'model-axis-model');
    await press(renderer, 'model-option-model-opus');

    expect(client.setAgentModelConfig).toHaveBeenCalledWith(WORKSPACE, AGENT, {
      model: 'opus',
      effort: 'high',
    });
  });


  it('shows the current selection but offers nothing without a live catalog', async () => {
    state.agent = {
      ...baseAgent(),
      catalog: [],
      selected: { model: 'openrouter/z-ai/glm-5.3-flash' },
    };
    const renderer = await render();
    await openAgentManagement(renderer);

    expect(renderer.root.findAllByProps({ testID: 'model-catalog-missing' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ testID: 'model-config-activation-note' })).toHaveLength(
      0,
    );
    expect(
      renderer.root.findByProps({ testID: 'model-axis-model' }).props.value,
    ).toBe('glm-5.3-flash');
    expect(
      renderer.root.findByProps({ testID: 'model-axis-effort' }).props.value,
    ).toBe('—');

    await press(renderer, 'model-axis-model');
    expect(renderer.root.findAllByProps({ testID: 'model-search-model' })).toHaveLength(0);
    expect(client.setAgentModelConfig).not.toHaveBeenCalled();
  });


  it('refreshes missing effort choices from the live catalog', async () => {
    state.agent = { ...baseAgent(), catalog: [], selected: undefined };
    const renderer = await render();
    await openAgentManagement(renderer);
    await press(renderer, 'model-axis-effort');
    await agentChanged();
    expect(client.refreshAgentModelCatalog).toHaveBeenCalledWith(WORKSPACE, AGENT);
    expect(renderer.root.findByProps({ testID: 'model-option-effort-low' })).toBeDefined();
    expect(renderer.root.findAllByProps({ testID: 'model-option-effort-xhigh' })).toHaveLength(0);
  });


  it('shows an actionable effort refresh failure instead of doing nothing', async () => {
    state.agent = { ...baseAgent(), catalog: [], selected: { model: 'sonnet' } };
    client.refreshAgentModelCatalog.mockRejectedValueOnce(new Error('agent offline'));
    const renderer = await render();
    await openAgentManagement(renderer);
    await press(renderer, 'model-axis-effort');

    expect(renderer.root.findByProps({ testID: 'model-axis-error-effort' }).props.children).toBe(
      'Could not load effort choices for this model. Make sure the agent is online, then try again or choose another model.',
    );
  });


  it('marks a persisted model that failed live startup validation', async () => {
    state.agent = { ...baseAgent(), modelUnavailable: 'model' };
    const renderer = await render();
    await openAgentManagement(renderer);
    expect(renderer.root.findByProps({ testID: 'model-unavailable-model' }).props.children).toBe(
      '!',
    );
  });
});
