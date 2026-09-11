import { describe, expect, it } from 'vitest';
import { cornerObjectiveItems } from './corner-context';

describe('cornerObjectiveItems', () => {
  it('pins the opening objective verbatim ahead of later plan objectives', () => {
    expect(
      cornerObjectiveItems({
        planObjective: 'plan says',
        task: 'task says',
        cornerName: 'name-says',
      }),
    ).toEqual(['task says']);
    expect(cornerObjectiveItems({ planObjective: 'plan says', cornerName: 'name-says' })).toEqual([
      'plan says',
    ]);
    expect(cornerObjectiveItems({ task: 'task says', cornerName: 'name-says' })).toEqual([
      'task says',
    ]);
    expect(cornerObjectiveItems({ cornerName: 'add-color-to-code-blocks' })).toEqual([]);
  });

  it('says nothing rather than naming a generated corner id', () => {
    expect(cornerObjectiveItems({ cornerName: 'corner-1a2b3c4d' })).toEqual([]);
    expect(cornerObjectiveItems({})).toEqual([]);
    expect(cornerObjectiveItems({ task: '   ' })).toEqual([]);
  });

  it('never renders raw tool plumbing as an objective', () => {
    expect(cornerObjectiveItems({ task: 'hint: Updates were rejected' })).toEqual([]);
    expect(cornerObjectiveItems({ planObjective: 'diff --git a/x b/x' })).toEqual([]);
  });

  it('does not truncate or rewrite the validated objective', () => {
    expect(cornerObjectiveItems({ task: 'add color to **code** blocks' })).toEqual([
      'add color to **code** blocks',
    ]);
    expect(cornerObjectiveItems({ task: 'x'.repeat(400) })).toEqual(['x'.repeat(400)]);
  });

  it('keeps parsing legacy plan objectives', () => {
    expect(
      cornerObjectiveItems({ planObjective: '- Trace the renderer\n- Add focused tests' }),
    ).toEqual(['Trace the renderer', 'Add focused tests']);
    expect(
      cornerObjectiveItems({
        planObjective: 'Update v1.2.3 parser; and verify src/foo.bar remains intact',
      }),
    ).toEqual(['Update v1.2.3 parser', 'verify src/foo.bar remains intact']);
  });
});
