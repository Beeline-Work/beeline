import { WORKSPACE, VIEWER, OWNER, AGENT, state, liveListeners, roomView, modal, navigation, client, phoneOperation, unistylesTheme, chevronDirections, baseWorkspace, baseAgent, create, render, press, openAgentProfile, openAgentManagement, fixtureScope1, fixtureScope2 } from './test-support-members.test-support';
import * as React from 'react';
import { StyleSheet } from 'react-native';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import MembersScreen from './members';
import { router } from 'expo-router';

describe('Members workspace management', () => {
const scope1 = fixtureScope1();


  it('edits the human-authored soul fields through setAgentSoul', async () => {
    state.agent.configVersion = '123';
    const renderer = await render();
    await openAgentProfile(renderer);
    expect(renderer.root.findByProps({ testID: 'generate-avatar-from-soul' })).toBeDefined();
    await openAgentManagement(renderer);
    await act(async () => {
      renderer.root.findByProps({ testID: 'agent-soul-name' }).props.onChangeText('Scout');
      renderer.root
        .findByProps({ testID: 'agent-soul-instructions' })
        .props.onChangeText('Look for regressions before shipping.');
    });
    const readsBeforeSave = roomView.agent.mock.calls.length;
    await press(renderer, 'save-agent-soul');
    expect(roomView.agent.mock.calls.length).toBe(readsBeforeSave);
    await act(async () => {
      for (const listener of liveListeners) listener({ monolithLive: {
        type: 'resource-change', roomId: '', resource: 'agent', resourceId: AGENT,
        version: '123',
      } });
    });
    expect(roomView.agent.mock.calls.length).toBe(readsBeforeSave);

    expect(client.setAgentSoul).toHaveBeenCalledWith(WORKSPACE, AGENT, {
      name: 'Scout',
      soul: 'Look for regressions before shipping.',
      avatarSeed: AGENT,
    });
  });


  it('opens the soul editor on the running soul with no seeded restore control', async () => {
    const renderer = await render();
    await openAgentManagement(renderer);
    // The editor opens on what the agent is actually running under.
    expect(renderer.root.findByProps({ testID: 'agent-soul-instructions' }).props.value).toBe(
      'Keep the tests green.',
    );
    // The seeded-restore control is gone; the editor carries only cancel/save.
    expect(renderer.root.findAllByProps({ testID: 'restore-seeded-soul' })).toHaveLength(0);
  });


  it('writes the seeded soul back when the owner pastes it in', async () => {
    const renderer = await render();
    await openAgentManagement(renderer);
    await act(async () => {
      renderer.root
        .findByProps({ testID: 'agent-soul-instructions' })
        .props.onChangeText(state.agent.seededSoul);
    });
    await press(renderer, 'save-agent-soul');
    expect(client.setAgentSoul).toHaveBeenCalledWith(WORKSPACE, AGENT, {
      name: 'Clara',
      soul: state.agent.seededSoul,
      avatarSeed: AGENT,
    });
  });


  it('keeps the soul input on the theme text token with a themed placeholder', async () => {
    const renderer = await render();
    await openAgentManagement(renderer);
    const input = renderer.root.findByProps({ testID: 'agent-soul-instructions' });
    expect(input.props.style.color).toBe(unistylesTheme.buzz.textPrimary);
    expect(input.props.placeholderTextColor).toBe(unistylesTheme.buzz.textMuted);
  });


  it('lets ordinary members open profiles without expanding roster rows', async () => {
    state.workspace = {
      ...baseWorkspace(),
      viewer: {
        ...baseWorkspace().viewer,
        role: 'member',
        permissions: { send: true, manage: false },
      },
    };
    const renderer = await render();
    const row = renderer.root.findByProps({ testID: `agent-${AGENT}-identity` });
    expect(row.props.disabled).toBe(false);
    expect(typeof row.props.onPress).toBe('function');
    expect(chevronDirections(row)).toEqual(['right']);
    await press(renderer, `agent-${AGENT}-identity`);
    expect(renderer.root.findAllByProps({ testID: `agent-${AGENT}-model-config` })).toHaveLength(0);
  });


  it('saves the edited soul server-side first and keeps retry local on failure', async () => {
    const renderer = await render();
    await openAgentManagement(renderer);
    await act(async () =>
      renderer.root
        .findByProps({ testID: 'agent-soul-instructions' })
        .props.onChangeText('A deity of faraway stars'),
    );
    client.publishPreparedMessage.mockRejectedValueOnce(new Error('offline'));
    await press(renderer, 'generate-avatar-from-soul');
    expect(client.setAgentSoul).toHaveBeenCalledWith(
      WORKSPACE,
      AGENT,
      expect.objectContaining({ soul: 'A deity of faraway stars' }),
    );
    expect(client.resolveDirectMessage).toHaveBeenCalledWith(WORKSPACE, AGENT);
    expect(client.composeMessage).toHaveBeenCalledWith(
      {
        sessionId: 'dm-room',
        text: '/draw-avatar',
      },
      { mentionAgent: AGENT },
    );
    expect(client.publishPreparedMessage).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'avatar-request' }),
    );
    expect(renderer.root.findAllByProps({ testID: 'avatar-refinement-hint' })).toHaveLength(0);
    expect(renderer.root.findByProps({ testID: 'generate-avatar-from-soul' }).props.title).toBe(
      'Retry avatar generation',
    );
    expect(
      renderer.root.findByProps({ testID: 'avatar-generation-error' }).props.children,
    ).toBe('Could not complete request');
  });


  it('saves the soul server-side and sends only the short draw request', async () => {
    const renderer = await render();
    await openAgentManagement(renderer);
    expect(renderer.root.findAllByProps({ testID: 'avatar-direction' })).toHaveLength(0);
    await act(async () =>
      renderer.root
        .findByProps({ testID: 'agent-soul-instructions' })
        .props.onChangeText('A deity of faraway stars'),
    );
    client.publishPreparedMessage.mockRejectedValueOnce(new Error('offline'));
    await press(renderer, 'generate-avatar-from-soul');
    expect(client.setAgentSoul).toHaveBeenCalledOnce();
    expect(client.composeMessage).toHaveBeenCalledWith(
      {
        sessionId: 'dm-room',
        text: '/draw-avatar',
      },
      { mentionAgent: AGENT },
    );
  });


  it('does not dispatch avatar generation when confirmation is canceled', async () => {
    const renderer = await render();
    await openAgentManagement(renderer);
    modal.confirm.mockResolvedValueOnce(false);
    await press(renderer, 'generate-avatar-from-soul');
    expect(client.composeMessage).not.toHaveBeenCalled();
    expect(renderer.root.findByProps({ testID: 'generate-avatar-from-soul' }).props.disabled).toBe(
      false,
    );
  });


  it('loads older work, preserves the current page on failure, and retries', async () => {
    state.agent = {
      ...baseAgent(),
      recentWork: [{ title: 'First', url: 'https://github.com/acme/repo/pull/2' }],
      recentWorkCursor: 'cursor-1',
    };
    const renderer = await render();
    await openAgentProfile(renderer);
    roomView.agent.mockRejectedValueOnce(new Error('offline'));
    await press(renderer, 'load-more-agent-work');
    expect(renderer.root.findByProps({ testID: 'load-more-agent-work' }).props.label).toBe(
      'Retry',
    );
    roomView.agent.mockResolvedValueOnce({
      ...baseAgent(),
      recentWork: [{ title: 'Older', url: 'https://github.com/acme/repo/pull/1' }],
    });
    await press(renderer, 'load-more-agent-work');
    expect(roomView.agent).toHaveBeenLastCalledWith(WORKSPACE, AGENT, 'cursor-1');
    expect(renderer.root.findAllByProps({ testID: 'load-more-agent-work' })).toHaveLength(0);
    expect(
      renderer.root
        .findAllByType('Text' as any)
        .some((node: any) => node.props.children === 'First'),
    ).toBe(true);
    expect(
      renderer.root
        .findAllByType('Text' as any)
        .some((node: any) => node.props.children === 'Older'),
    ).toBe(true);
  });


  it('shows the seeded soul when its owner has not written one', async () => {
    state.agent = { ...baseAgent(), soul: undefined };
    const renderer = await render();
    await openAgentProfile(renderer);
    expect(renderer.root.findByProps({ testID: 'agent-profile-soul' }).props.children).toBe(
      state.agent.seededSoul,
    );
  });


  it('shows ordinary members the profile and Message action without management', async () => {
    state.workspace = {
      ...baseWorkspace(),
      viewer: {
        ...baseWorkspace().viewer,
        role: 'member',
        permissions: { send: true, manage: false },
      },
    };
    state.agent = {
      ...baseAgent(),
      access: { policy: 'everyone', canChange: false, owner: { id: OWNER, name: 'Captain' } },
    };
    const renderer = await render();
    await openAgentProfile(renderer);
    expect(renderer.root.findAllByProps({ testID: 'edit-agent-soul' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ testID: 'generate-avatar-from-soul' })).toHaveLength(0);
    expect(renderer.root.findByProps({ testID: 'agent-profile-soul' }).props.children).toBe(
      state.agent.soul.instructions,
    );
    expect(renderer.root.findByProps({ testID: 'agent-profile-no-work' })).toBeDefined();
    // Reproduction R1: the empty text starts on the RECENT WORK header's edge.
    expect(
      StyleSheet.flatten(renderer.root.findByProps({ testID: 'agent-profile-no-work' }).props.style),
    ).toMatchObject({ paddingHorizontal: unistylesTheme.buzz.space.sm });
    await press(renderer, 'agent-profile-message');
    expect(client.resolveDirectMessage).toHaveBeenCalledWith(WORKSPACE, AGENT);
  });


  it('keeps a profile read failure and Retry after a successful workspace refresh', async () => {
    roomView.agent.mockRejectedValueOnce(new Error('Connection lost'));
    const renderer = await render();
    await openAgentProfile(renderer);
    expect(renderer.root.findAllByProps({ action: 'Retry' })).not.toHaveLength(0);
    const subscriptions = client.surfaceSubscribe.mock.calls as unknown as Array<
      [unknown, (event?: unknown) => void]
    >;
    const refresh = subscriptions.at(-1)![1];
    const readsBeforeRefresh = roomView.workspace.mock.calls.length;
    await act(async () => refresh({ monolithLive: { type: 'invalidate', roomId: '', reason: 'postgres:memberships' } }));
    expect(roomView.workspace.mock.calls.length).toBeGreaterThan(readsBeforeRefresh);
    const retry = renderer.root.findAllByProps({ action: 'Retry' })[0];
    expect(retry).toBeDefined();
    await act(async () => retry.props.onPress());
    expect(roomView.agent).toHaveBeenCalledTimes(2);
    expect(renderer.root.findByProps({ testID: 'agent-profile-soul' })).toBeDefined();
  });


  it('R-USAGE-6: shows a cached profile, then reads it again from the server', async () => {
    const { mobileSurfaceCache, surfaceAddress } = await import('@/buzz/surface-storage');
    await act(async () => mobileSurfaceCache.write(
      surfaceAddress('https://relay.test', VIEWER, '/workspace/:id/agents/:agentId',
        { workspaceId: WORKSPACE, agentPubkey: AGENT }),
      { ...state.agent, soul: { ...state.agent.soul, instructions: 'Cached soul.' } },
      (value: unknown): value is typeof state.agent => Boolean(value)));
    const renderer = await render();
    await openAgentProfile(renderer);
    expect(roomView.agent).toHaveBeenCalledTimes(1);
    expect(renderer.root.findByProps({ testID: 'agent-profile-soul' }).props.children).toBe(
      state.agent.soul.instructions,
    );
  });


  it('retries a failed profile read without collapsing the profile', async () => {
    roomView.agent.mockRejectedValueOnce(new Error('Connection lost'));
    const renderer = await render();
    await openAgentProfile(renderer);
    const retry = renderer.root.findAllByProps({ action: 'Retry' })[0];
    await act(async () => retry.props.onPress());
    expect(roomView.agent).toHaveBeenCalledTimes(2);
    expect(renderer.root.findByProps({ testID: 'agent-profile-soul' })).toBeDefined();
  });


  it('opens the profile route from a roster identity without inline settings', async () => {
    const renderer = await render();
    expect(renderer.root.findAllByProps({ testID: `agent-${AGENT}-model-config` })).toHaveLength(0);
    await press(renderer, `agent-${AGENT}-identity`);
    expect(router.push).toHaveBeenCalledWith({
      pathname: '/beeline/agent-profile',
      params: { communityId: WORKSPACE, agentId: AGENT },
    });
    expect(renderer.root.findAllByProps({ testID: `agent-${AGENT}-model-config` })).toHaveLength(0);
    await openAgentManagement(renderer);
    expect(renderer.root.findByProps({ testID: `agent-${AGENT}-model-config` })).toBeDefined();
  });


  it('edits in the profile and returns to reading on Cancel', async () => {
    const renderer = await render();
    await openAgentManagement(renderer);
    expect(renderer.root.findByProps({ testID: 'agent-soul-instructions' })).toBeDefined();
    await press(renderer, 'cancel-agent-edit');
    expect(renderer.root.findAllByProps({ testID: `agent-${AGENT}-model-config` })).toHaveLength(0);
    expect(renderer.root.findByProps({ testID: 'agent-profile-soul' }).props.children).toBe(
      state.agent.soul.instructions,
    );
    expect(renderer.root.findByProps({ testID: 'agent-profile-no-work' })).toBeDefined();
    expect(renderer.root.findByProps({ testID: 'edit-agent-soul' })).toBeDefined();
  });


  it('keeps unsaved name and soul edits when Close is declined', async () => {
    const renderer = await render();
    await openAgentManagement(renderer);
    await act(async () => {
      renderer.root.findByProps({ testID: 'agent-soul-name' }).props.onChangeText('Scout');
    });
    modal.confirm.mockResolvedValueOnce(false);
    await press(renderer, 'close-agent-profile');
    expect(modal.confirm).toHaveBeenCalledWith(
      'Discard agent changes?',
      'Your name and soul edits have not been saved.',
      { cancelText: 'Keep editing', confirmText: 'Discard', destructive: true },
    );
    expect(renderer.root.findByProps({ testID: 'agent-soul-name' }).props.value).toBe('Scout');
    expect(router.back).not.toHaveBeenCalled();
    await press(renderer, 'save-agent-soul');
    expect(client.setAgentSoul).toHaveBeenCalledOnce();
    await press(renderer, 'close-agent-profile');
    expect(router.back).toHaveBeenCalledOnce();
  });


  it('guards a native back navigation while the soul draft is dirty', async () => {
    const renderer = await render();
    await openAgentManagement(renderer);
    await act(async () => {
      renderer.root
        .findByProps({ testID: 'agent-soul-instructions' })
        .props.onChangeText('New soul');
    });
    const action = { type: 'GO_BACK' };
    const preventDefault = vi.fn();
    modal.confirm.mockResolvedValueOnce(false);
    await act(async () => navigation.beforeRemove?.({ preventDefault, data: { action } }));
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(navigation.dispatch).not.toHaveBeenCalled();
    expect(renderer.root.findByProps({ testID: 'agent-soul-instructions' }).props.value).toBe(
      'New soul',
    );
    await act(async () => navigation.beforeRemove?.({ preventDefault, data: { action } }));
    expect(navigation.dispatch).toHaveBeenCalledWith(action);
  });


  it('lets the owner open the agent to everyone, and names who to ask until they do', async () => {
    const renderer = await render();
    await openAgentManagement(renderer);

    const toggle = renderer.root.findByProps({ testID: 'agent-access-switch' });
    expect(toggle.props.disabled).toBe(false);
    expect(toggle.props.value).toBe(false);
    // The owner is named by @handle here for the same reason the Room's system
    // lines name them that way: a display name is not an address.
    expect(renderer.root.findByProps({ testID: 'agent-access-caption' }).props.children).toBe(
      'Only @viewer may ask this agent; everyone else is told to ask @viewer here. ' +
        'Only the owner can change this.',
    );

    await act(async () => {
      await toggle.props.onValueChange(true);
    });

    expect(phoneOperation).toHaveBeenCalledWith('updateAgentAccessPolicy', {
      workspaceId: WORKSPACE,
      agentId: AGENT,
      policy: 'everyone',
    });
    expect(renderer.root.findByProps({ testID: 'agent-access-switch' }).props.value).toBe(true);
    expect(renderer.root.findByProps({ testID: 'agent-access-caption' }).props.children).toBe(
      'Anyone in the Room can have Clara run commands, install software and change configuration ' +
        'on your machine. Turn this off and only you may ask them.',
    );
    expect(renderer.root.findAllByProps({ testID: 'agent-access-error' })).toHaveLength(0);
  });


  it("hides another owner's agent configuration from a plain member", async () => {
    state.workspace = {
      ...baseWorkspace(),
      viewer: {
        ...baseWorkspace().viewer,
        role: 'member',
        permissions: { send: true, manage: false },
      },
    };
    state.agent = {
      ...baseAgent(),
      access: {
        policy: 'creator',
        owner: { id: OWNER, name: 'Captain', handle: 'lunchboxfortwo' },
        canChange: false,
      },
    };
    const renderer = await render();
    // A plain member cannot open the detail panel at all: the row is inert.
    expect(renderer.root.findAllByProps({ testID: `agent-${AGENT}-model-config` })).toHaveLength(0);

    expect(renderer.root.findAllByProps({ testID: 'agent-access-switch' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ testID: 'edit-agent-soul' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ testID: 'model-axis-model' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ testID: 'remove-agent' })).toHaveLength(0);
  });


  it("offers an admin only Remove from Workspace for another owner's agent", async () => {
    state.workspace = baseWorkspace('admin');
    state.agent = {
      ...baseAgent(),
      access: {
        policy: 'creator',
        owner: { id: OWNER, name: 'Captain', handle: 'lunchboxfortwo' },
        canChange: false,
      },
      yolo: { enabled: false, canChange: false },
    };
    const renderer = await render();
    await openAgentManagement(renderer);

    expect(renderer.root.findAllByProps({ testID: 'edit-agent-soul' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ testID: 'model-axis-model' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ testID: 'agent-access-switch' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ testID: 'agent-yolo-switch' })).toHaveLength(0);
    expect(
      renderer.root
        .findByProps({ testID: 'profile-handle' })
        .findAllByType('Text')
        .flatMap((node: any) => node.children)
        .filter((child: any) => typeof child === 'string')
        .join(''),
    ).toContain('clara');
    // An agent is removed, never banned: its owner could pair it back as a new agent.
    const remove = renderer.root.findByProps({ testID: 'remove-agent' });
    expect(remove.props.accessibilityLabel).toBe('Remove from Workspace');
    expect(remove.props.label).toBe('Remove from Workspace');

    await press(renderer, 'remove-agent');
    expect(modal.confirm).toHaveBeenCalledWith('Remove Clara?', expect.any(String), {
      cancelText: 'Cancel',
      confirmText: 'Remove agent',
      destructive: true,
      pendingText: 'Removing…',
      onConfirm: expect.any(Function),
    });
    expect(client.removeAgent).toHaveBeenCalledWith(WORKSPACE, AGENT);
  });


  it('lets the owner flip yolo and shows who set it', async () => {
    const renderer = await render();
    await openAgentManagement(renderer);

    const toggle = renderer.root.findByProps({ testID: 'agent-yolo-switch' });
    expect(toggle.props.disabled).toBe(false);
    expect(toggle.props.value).toBe(false);
    expect(toggle.props.trackColor).toEqual({ false: '#111', true: '#d7af5f' });
    expect(renderer.root.findByProps({ testID: 'agent-yolo-caption' }).props.children).toBe(
      'Clara acts without stopping to ask. Two things still ask you: anything that names one of ' +
        'your credentials, and a script nobody has read.',
    );
    expect(renderer.root.findAllByProps({ testID: 'agent-yolo-set-by' })).toHaveLength(0);

    await act(async () => {
      await toggle.props.onValueChange(true);
    });

    expect(phoneOperation).toHaveBeenCalledWith('updateAgentYolo', {
      workspaceId: WORKSPACE,
      agentId: AGENT,
      enabled: true,
    });
    expect(renderer.root.findByProps({ testID: 'agent-yolo-switch' }).props.value).toBe(true);
    const setBy = renderer.root.findByProps({ testID: 'agent-yolo-set-by' }).props.children;
    expect(setBy).toMatch(/^Set by Viewer · /);
    expect(setBy).toContain('2025');
    expect(renderer.root.findAllByProps({ testID: 'agent-yolo-error' })).toHaveLength(0);
  });


  it('shows an owner that public Workspace policy forces yolo off', async () => {
    state.agent = {
      ...baseAgent(),
      yolo: { enabled: false, forcedOff: true, canChange: true },
    };
    const renderer = await render();
    await openAgentManagement(renderer);

    expect(renderer.root.findByProps({ testID: 'agent-yolo-switch' }).props).toMatchObject({
      disabled: true,
      value: false,
    });
    expect(renderer.root.findByProps({ testID: 'agent-yolo-caption' }).props.children).toBe(
      'Yolo is forced off while this workspace is public.',
    );
  });


  it("hides another owner's yolo setting from a plain member", async () => {
    state.workspace = {
      ...baseWorkspace(),
      viewer: {
        ...baseWorkspace().viewer,
        role: 'member',
        permissions: { send: true, manage: false },
      },
    };
    state.agent = {
      ...baseAgent(),
      access: {
        policy: 'creator',
        owner: { id: OWNER, name: 'Captain', handle: 'lunchboxfortwo' },
        canChange: false,
      },
      yolo: { enabled: true, canChange: false, setBy: { name: 'Captain' }, setAt: 1_756_684_800 },
    };
    const renderer = await render();
    // A plain member cannot open the detail panel at all: the row is inert.
    expect(renderer.root.findAllByProps({ testID: `agent-${AGENT}-model-config` })).toHaveLength(0);

    expect(renderer.root.findAllByProps({ testID: 'agent-yolo-switch' })).toHaveLength(0);
  });
describe.each([
    ['yolo', 'updateAgentYolo'],
    ['access', 'updateAgentAccessPolicy'],
  ])('R4: %s toggle failure copy on the Members route', (toggle, operation) => {
const scope2 = fixtureScope2(scope1, toggle, operation);

    it.each([
      [504, 'surface_request_timed_out', 'Could not complete request'],
      [403, 'permission_denied', 'Could not complete request'],
      [400, 'The timeout must be shorter.', 'The timeout must be shorter.'],
    ])('formats status %s with code %s', async (status, code, expected) => {
      const renderer = await render();
      await openAgentManagement(renderer);
      phoneOperation.mockRejectedValueOnce(Object.assign(
        new Error(`Monolith ${scope2.operation} failed (${status}): ${code}`), { status, code },
      ));
      await act(async () => {
        await renderer.root.findByProps({ testID: `agent-${scope2.toggle}-switch` }).props.onValueChange(true);
      });
      expect(phoneOperation).toHaveBeenCalledWith(scope2.operation, expect.any(Object));
      expect(renderer.root.findByProps({ testID: `agent-${scope2.toggle}-error` }).props.children).toBe(expected);
      expect(renderer.root.findByProps({ testID: `agent-${scope2.toggle}-switch` }).props.value).toBe(false);
    });
});


  it('flips yolo optimistically and rolls back with the server message when refused', async () => {
    const renderer = await render();
    await openAgentManagement(renderer);

    let settle!: () => void;
    const pending = new Promise<void>((resolve) => (settle = resolve));
    phoneOperation.mockImplementationOnce(async () => {
      await pending;
      throw Object.assign(new Error('Monolith updateAgentYolo failed (403)'), {
        code: "Only the agent's owner can change this",
      });
    });
    let flip!: Promise<void>;
    await act(async () => {
      flip = renderer.root.findByProps({ testID: 'agent-yolo-switch' }).props.onValueChange(true);
    });
    // Optimistic: on before the server answers.
    expect(renderer.root.findByProps({ testID: 'agent-yolo-switch' }).props.value).toBe(true);
    await act(async () => {
      settle();
      await flip;
    });
    // Rolled back with the server's plain message inline.
    expect(renderer.root.findByProps({ testID: 'agent-yolo-switch' }).props.value).toBe(false);
    expect(renderer.root.findByProps({ testID: 'agent-yolo-error' }).props.children).toBe(
      "Only the agent's owner can change this",
    );
    expect(roomView.agent).toHaveBeenCalled();
  });


  it('warns about and invokes the full removeAgent host teardown path', async () => {
    const renderer = await render();
    await openAgentManagement(renderer);

    // Management names the agent and owner before offering removal.
    expect(
      renderer.root
        .findByProps({ testID: 'profile-handle' })
        .findAllByType('Text')
        .flatMap((node: any) => node.children)
        .filter((child: any) => typeof child === 'string')
        .join(''),
    ).toContain('clara');
    expect(
      renderer.root
        .findByProps({ testID: 'profile-owner' })
        .findAllByType('Text')
        .flatMap((node: any) => node.children)
        .filter((child: any) => typeof child === 'string')
        .join(''),
    ).toContain('viewer');
    const control = renderer.root.findByProps({ testID: 'remove-agent' });
    expect(control.props.accessibilityLabel).toBe('Remove from Workspace');
    expect(control.props.label).toBe('Remove from Workspace');
    expect(control.props.variant).toBe('danger');
    expect(control.props.fullWidth).toBe(true);

    await press(renderer, 'remove-agent');

    expect(modal.confirm).toHaveBeenCalledWith(
      'Remove Clara?',
      expect.stringMatching(
        /every Room.*paired host.*drains active sessions.*runtime configuration/i,
      ),
      { cancelText: 'Cancel', confirmText: 'Remove agent', destructive: true, pendingText: 'Removing…', onConfirm: expect.any(Function) },
    );
    expect(client.removeAgent).toHaveBeenCalledWith(WORKSPACE, AGENT);
  });


  it('draws a removed agent nowhere: no row, no count, no open detail', async () => {
    const renderer = await render();
    await openAgentManagement(renderer);
    await press(renderer, 'remove-agent');

    await act(async () => {
      renderer.update(React.createElement(MembersScreen, { key: 'roster-return' }));
    });
    // The server stops naming it, so the screen stops drawing it — the row,
    // the count, and the detail the removal was performed from.
    expect(renderer.root.findAllByProps({ testID: `agent-${AGENT}-identity` })).toHaveLength(0);
    expect(renderer.root.findByProps({ testID: 'members-agents-head' }).props.count).toEqual(0);
    expect(renderer.root.findAllByProps({ testID: 'remove-agent' })).toHaveLength(0);
  });

  it('repaints the Members list under an agent profile from the profile receipt', async () => {
    const list = await render();
    const row = () => list.root.findAllByProps({ testID: `agent-${AGENT}-identity` })
      .find((node: any) => typeof node.props.name === 'string')!.props;
    expect(row().name).toBe('Clara');
    let profile!: ReactTestRenderer;
    await act(async () => {
      profile = create(<MembersScreen profileAgentId={AGENT} workspaceIdOverride={WORKSPACE} />);
    });
    await press(profile, 'edit-agent-soul');
    await act(async () => {
      profile.root.findByProps({ testID: 'agent-soul-name' }).props.onChangeText('Scout');
    });
    const workspaceReads = roomView.workspace.mock.calls.length;
    await press(profile, 'save-agent-soul');
    expect(row().name).toBe('Scout');
    expect(roomView.workspace.mock.calls.length).toBe(workspaceReads);
  });


  it('patches a paged agent row under its profile on rename and removal (J26)', async () => {
    const PAGED = 'f'.repeat(64);
    const paged = {
      identity: { pubkey: PAGED, kind: 'agent', name: 'Pip', handle: 'pip' },
      role: 'member',
      model: 'Sonnet',
      owner: { pubkey: VIEWER, kind: 'human', name: 'Viewer', handle: 'viewer' },
    };
    state.workspace = { ...baseWorkspace(), agentTotal: 2, agentsTruncated: true };
    state.agent = {
      ...baseAgent(),
      agent: { identity: paged.identity, role: 'member' },
      soul: { name: 'Pip', instructions: 'Keep the tests green.', avatarSeed: PAGED },
    };
    roomView.workspaceMembers.mockImplementation(async (_workspaceId: string, query: any = {}) => ({
      viewer: state.workspace.viewer,
      members: query.kind === 'agent' ? [] : state.workspace.members,
      agents: Number(query.offset ?? 0) > 0 ? [paged] : state.workspace.agents,
      peopleTotal: state.workspace.peopleTotal,
      agentTotal: 2,
      membersTruncated: false,
      agentsTruncated: false,
    }));
    const list = await render();
    await press(list, 'members-load-more-agents');
    const pagedName = () => list.root.findAllByProps({ testID: `agent-${PAGED}-identity` })
      .find((node: any) => typeof node.props.name === 'string')?.props.name;
    expect(pagedName()).toBe('Pip');

    let profile!: ReactTestRenderer;
    await act(async () => {
      profile = create(<MembersScreen profileAgentId={PAGED} workspaceIdOverride={WORKSPACE} />);
    });
    await press(profile, 'edit-agent-soul');
    await act(async () => {
      profile.root.findByProps({ testID: 'agent-soul-name' }).props.onChangeText('Scout');
    });
    await press(profile, 'save-agent-soul');
    expect(pagedName()).toBe('Scout');

    await press(profile, 'edit-agent-soul');
    await press(profile, 'remove-agent');
    expect(list.root.findAllByProps({ testID: `agent-${PAGED}-identity` })).toHaveLength(0);
    expect(list.root.findByProps({ testID: 'members-agents-head' }).props.count).toEqual(1);
  });


  it('drops an agent removed from its profile out of the Members list underneath', async () => {
    const list = await render();
    let profile!: ReactTestRenderer;
    await act(async () => {
      profile = create(<MembersScreen profileAgentId={AGENT} workspaceIdOverride={WORKSPACE} />);
    });
    await press(profile, 'edit-agent-soul');
    const workspaceReads = roomView.workspace.mock.calls.length;
    await press(profile, 'remove-agent');
    expect(list.root.findAllByProps({ testID: `agent-${AGENT}-identity` })).toHaveLength(0);
    expect(list.root.findByProps({ testID: 'members-agents-head' }).props.count).toEqual(0);
    expect(roomView.workspace.mock.calls.length).toBe(workspaceReads);
  });


  it('drops an agent another session removed from a searched roster on a global membership signal (P1, G7-R2)', async () => {
    const renderer = await render();
    await act(async () => {
      renderer.root.findByProps({ testID: 'members-search' }).props.onChangeText('Clara');
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(renderer.root.findAllByProps({ testID: `agent-${AGENT}-identity` })).not.toHaveLength(0);

    // Another session removes Clara; the Workspace refresh no longer lists her.
    state.workspace = { ...baseWorkspace(), agents: [], agentTotal: 0 };
    const subscriptions = client.surfaceSubscribe.mock.calls as unknown as Array<
      [unknown, (event?: unknown) => void]
    >;
    const global = subscriptions.find(([filters]) => Array.isArray(filters) && filters.length === 0);
    expect(global).toBeDefined();
    const reads = roomView.workspace.mock.calls.length;
    await act(async () => (global![1] as (event: unknown) => void)({
      monolithLive: { type: 'invalidate', roomId: '', reason: 'postgres:memberships' },
    }));
    expect(roomView.workspace.mock.calls.length).toBeGreaterThan(reads);

    expect(renderer.root.findAllByProps({ testID: `agent-${AGENT}-identity` })).toHaveLength(0);
  });


  it('keeps a searched agent a truncated Workspace refresh only leaves out', async () => {
    const renderer = await render();
    await act(async () => {
      renderer.root.findByProps({ testID: 'members-search' }).props.onChangeText('Clara');
      await Promise.resolve();
      await Promise.resolve();
    });

    state.workspace = { ...baseWorkspace(), agents: [], agentTotal: 1, agentsTruncated: true };
    const subscriptions = client.surfaceSubscribe.mock.calls as unknown as Array<
      [unknown, (event?: unknown) => void]
    >;
    await act(async () => subscriptions.at(-1)![1]({ monolithLive: { type: 'invalidate', roomId: '', reason: 'postgres:memberships' } } as never));

    expect(renderer.root.findAllByProps({ testID: `agent-${AGENT}-identity` })).not.toHaveLength(0);
  });
});
