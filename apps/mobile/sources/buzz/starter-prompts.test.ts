import { describe, expect, it } from 'vitest';
import { roomStarterPrompts } from './starter-prompts';

describe('the first Room starter prompts', () => {
  it('offers the pairing command instead of asks nobody can answer', () => {
    // A Workspace made through the create wizard has one member: the creator.
    for (const noAgent of [undefined, null, { pubkey: 'agent-1' }]) {
      const prompts = roomStarterPrompts(noAgent);
      expect(prompts.map((prompt) => prompt.testID)).toEqual([
        'starter-connect-agent',
        'starter-invite',
      ]);
      expect(prompts[0]!.action).toEqual({ kind: 'connect-agent' });
      expect(prompts.some((prompt) => prompt.action.kind === 'fill')).toBe(false);
    }
  });

  it('tags the Room agent once there is one, and drops the pairing starter', () => {
    const prompts = roomStarterPrompts({ pubkey: 'agent-1', handle: 'scout' });
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
    for (const agent of [undefined, { pubkey: 'agent-1', handle: 'scout' }])
      expect(roomStarterPrompts(agent).at(-1)).toEqual({
        lead: 'Invite someone',
        detail: 'who should see the result',
        testID: 'starter-invite',
        action: { kind: 'invite-person' },
      });
  });
});
