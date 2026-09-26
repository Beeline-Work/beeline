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

  it('keeps a started draft, and brings a starter prompt to it instead of nothing', () => {
    const plan = planComposerFill({
      draft: 'half a thought',
      text: '@scout Help me turn this idea into a plan: ',
      mention: { handle: 'scout', pubkey: 'agent-1' },
      focusOnRefusal: true,
    });
    expect(plan.fill).toBeNull();
    expect(plan.focus).toBe(true);
  });

  it('leaves the composer alone when the refused caller keeps its own surface up', () => {
    // The catch-up sheet stays open over the composer, so focusing behind it
    // would raise a keyboard under the sheet and answer nothing.
    expect(
      planComposerFill({
        draft: 'half a thought',
        text: '@scout Please catch me up',
        mention: { handle: 'scout', pubkey: 'agent-1' },
      }),
    ).toEqual({ focus: false, fill: null });
  });
});
