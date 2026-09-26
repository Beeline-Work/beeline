import { describe, expect, it } from 'vitest';
import { roomStarterPrompts } from './starter-prompts';

const MANAGER = { canManageWorkspace: true };

describe('the first Room starter prompts', () => {
  it('offers the pairing command when the Workspace has no agent at all', () => {
    // The dominant first run: a Workspace made through the create wizard has
    // one member, the creator, and nobody to ask yet.
    for (const roomAgent of [undefined, null, { pubkey: 'agent-1' }]) {
      const prompts = roomStarterPrompts({ ...MANAGER, roomAgent, workspaceAgentCount: 0 });
      expect(prompts.map((prompt) => prompt.testID)).toEqual([
        'starter-connect-agent',
        'starter-invite',
      ]);
      expect(prompts[0]!.action).toEqual({ kind: 'connect-agent' });
    }
  });

  it('offers the Room agent picker when the Workspace already has agents', () => {
    // Minting a second agent here would install one nobody asked for; the
    // Workspace's existing agent only has to join this Room.
    const prompts = roomStarterPrompts({ ...MANAGER, workspaceAgentCount: 2 });
    expect(prompts.map((prompt) => prompt.testID)).toEqual(['starter-add-agent', 'starter-invite']);
    expect(prompts[0]!.action).toEqual({ kind: 'add-room-agent' });
  });

  it('prefers the picker while the Workspace roster is still unread', () => {
    expect(roomStarterPrompts({ ...MANAGER, workspaceAgentCount: null })[0]!.action).toEqual({
      kind: 'add-room-agent',
    });
  });

  it('offers pairing when the Workspace has no agent, regardless of Room management permission', () => {
    expect(
      roomStarterPrompts({ canManageWorkspace: false, workspaceAgentCount: 0 }).map(
        (prompt) => prompt.testID,
      ),
    ).toEqual(['starter-connect-agent']);
  });

  it('offers neither the agent picker nor the invite when the viewer cannot manage the Workspace', () => {
    for (const workspaceAgentCount of [3, null])
      expect(
        roomStarterPrompts({ canManageWorkspace: false, workspaceAgentCount }).map(
          (prompt) => prompt.testID,
        ),
      ).toEqual([]);
  });

  it('never offers the invite starter to a member who cannot mint an invite', () => {
    // createInvite requires a Workspace manager; the starter would be a dead
    // end for anyone else.
    for (const roomAgent of [undefined, { pubkey: 'agent-1', handle: 'scout' }])
      for (const workspaceAgentCount of [0, 1, null])
        expect(
          roomStarterPrompts({ canManageWorkspace: false, roomAgent, workspaceAgentCount }).map(
            (prompt) => prompt.testID,
          ),
        ).not.toContain('starter-invite');
    expect(
      roomStarterPrompts({
        canManageWorkspace: false,
        roomAgent: { pubkey: 'agent-1', handle: 'scout' },
        workspaceAgentCount: 1,
      }).map((prompt) => prompt.testID),
    ).toEqual(['starter-ask-agent', 'starter-open-corner']);
  });

  it('tags the Room agent once there is one, and drops the agent-getting starter', () => {
    const prompts = roomStarterPrompts({
      ...MANAGER,
      roomAgent: { pubkey: 'agent-1', handle: 'scout' },
      workspaceAgentCount: 1,
    });
    expect(prompts.map((prompt) => prompt.testID)).toEqual([
      'starter-ask-agent',
      'starter-open-corner',
      'starter-invite',
    ]);
    expect(prompts[0]!.action).toEqual({
      kind: 'fill',
      text: '@scout Help me turn this idea into a plan: ',
      mention: { handle: 'scout', pubkey: 'agent-1' },
    });
    expect(prompts[1]!.action).toEqual({
      kind: 'fill',
      text: '@scout Open a corner to ',
      mention: { handle: 'scout', pubkey: 'agent-1' },
    });
  });

  it('always keeps the invite starter last', () => {
    for (const roomAgent of [undefined, { pubkey: 'agent-1', handle: 'scout' }])
      expect(roomStarterPrompts({ ...MANAGER, roomAgent, workspaceAgentCount: 1 }).at(-1)).toEqual({
        lead: 'Invite someone',
        detail: 'who should see the result',
        testID: 'starter-invite',
        action: { kind: 'invite-person' },
      });
  });
});
