import { describe, expect, it } from 'vitest';
import { cornerObjectiveItems, cornerObjectiveLine } from './corner-context';

describe('cornerObjectiveLine', () => {
  it('pins the opening objective verbatim ahead of later plan objectives', () => {
    expect(
      cornerObjectiveLine({
        planObjective: 'plan says',
        task: 'task says',
        cornerName: 'name-says',
      }),
    ).toBe('task says');
    expect(cornerObjectiveLine({ planObjective: 'plan says', cornerName: 'name-says' })).toBe(
      'plan says',
    );
    expect(cornerObjectiveLine({ task: 'task says', cornerName: 'name-says' })).toBe('task says');
    expect(cornerObjectiveLine({ cornerName: 'add-color-to-code-blocks' })).toBeUndefined();
  });

  it('says nothing rather than naming a generated corner id', () => {
    expect(cornerObjectiveLine({ cornerName: 'corner-1a2b3c4d' })).toBeUndefined();
    expect(cornerObjectiveLine({})).toBeUndefined();
    expect(cornerObjectiveLine({ task: '   ' })).toBeUndefined();
  });

  it('never renders raw tool plumbing as an objective', () => {
    expect(cornerObjectiveLine({ task: 'hint: Updates were rejected' })).toBeUndefined();
    expect(cornerObjectiveLine({ planObjective: 'diff --git a/x b/x' })).toBeUndefined();
  });

  it('does not truncate or rewrite the validated objective', () => {
    const line = cornerObjectiveLine({ task: 'add color to **code** blocks' });
    expect(line).toBe('add color to **code** blocks');
    const long = cornerObjectiveLine({ task: 'x'.repeat(400) });
    expect(long).toBe('x'.repeat(400));
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
