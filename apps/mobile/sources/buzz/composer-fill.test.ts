import { describe, expect, it } from 'vitest';
import { planComposerFill } from './composer-fill';

describe('filling the composer from a prompt', () => {
  it('fills an empty composer and leaves the caret after the text', () => {
    expect(planComposerFill({ draft: '', text: '@scout Open a corner to ' })).toEqual({
      focus: true,
      fill: {
        text: '@scout Open a corner to ',
        selection: { start: 24, end: 24 },
      },
    });
  });

  it('registers the addressed agent so ordinary mention routing applies', () => {
    expect(
      planComposerFill({
        draft: '   ',
        text: '@scout Please catch me up',
        mention: { handle: '@scout', pubkey: 'agent-1' },
      }).fill,
    ).toEqual({
      text: '@scout Please catch me up',
      selection: { start: 25, end: 25 },
      mention: { handle: 'scout', pubkey: 'agent-1' },
    });
  });

  it('keeps a started draft and still brings the person to it', () => {
    const plan = planComposerFill({
      draft: 'half a thought',
      text: '@scout Help me turn this idea into a plan: ',
      mention: { handle: 'scout', pubkey: 'agent-1' },
    });
    expect(plan.fill).toBeNull();
    expect(plan.focus).toBe(true);
  });
});
