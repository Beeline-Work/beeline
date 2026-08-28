import { describe, expect, it } from 'vitest';
import { cornerObjectiveLine } from './corner-context';

describe('cornerObjectiveLine', () => {
  it('pins the opening task ahead of later plan objectives, then falls back to the corner name', () => {
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
    expect(cornerObjectiveLine({ cornerName: 'add-color-to-code-blocks' })).toBe(
      'add color to code blocks',
    );
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

  it('collapses a multi-line task to one line without discarding long objective text', () => {
    const line = cornerObjectiveLine({ task: `add color\n\nto **code** blocks` });
    expect(line).toBe('add color to code blocks');
    const long = cornerObjectiveLine({ task: 'x'.repeat(400) });
    expect(long).toBe('x'.repeat(400));
  });
});
