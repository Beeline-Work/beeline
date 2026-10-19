import { describe, expect, it } from 'vitest';
import type { AgentTurnStep } from './acp.js';
import { MAX_NOTE_LENGTH, MAX_REPLY_STEPS, roomReplySteps } from './room-turn-steps.js';

const note = (text: string): AgentTurnStep => ({ kind: 'note', text });
const tool = (title: string): AgentTurnStep => ({
  kind: 'tool',
  call: { id: title, title, kind: 'other', status: 'completed' },
});
const noteText = (rows: ReturnType<typeof roomReplySteps>) =>
  rows.filter((row) => row.kind === 'note').map((row) => row.text).join('');

describe('roomReplySteps', () => {
  it('keeps every note whole and in order between the tools', () => {
    expect(roomReplySteps([note('First.'), tool('a'), note('Second.'), tool('b')])).toEqual([
      { kind: 'note', title: 'Note', text: 'First.' },
      expect.objectContaining({ kind: 'tool', title: 'a' }),
      { kind: 'note', title: 'Note', text: 'Second.' },
      expect.objectContaining({ kind: 'tool', title: 'b' }),
    ]);
  });

  it('splits a note longer than the bound across continuing notes, losing nothing', () => {
    const long = `Start. ${'x'.repeat(MAX_NOTE_LENGTH)} End.`;
    const rows = roomReplySteps([note(long), tool('a')]);
    expect(rows.map((row) => [row.kind, row.continues ?? false])).toEqual([
      ['note', false],
      ['note', true],
      ['tool', false],
    ]);
    expect(rows.every((row) => (row.text ?? '').length <= MAX_NOTE_LENGTH)).toBe(true);
    expect(noteText(rows)).toBe(long);
  });

  it('never splits inside a surrogate pair', () => {
    const long = `${'x'.repeat(MAX_NOTE_LENGTH - 1)}😀tail`;
    const rows = roomReplySteps([note(long)]);
    expect(rows[0]!.text).toBe('x'.repeat(MAX_NOTE_LENGTH - 1));
    expect(noteText(rows)).toBe(long);
  });

  it('folds the oldest tools, never a note, when the steps exceed the bound', () => {
    const steps = [
      note('Before the tools.'),
      ...Array.from({ length: MAX_REPLY_STEPS }, (_, index) => tool(`t${index}`)),
    ];
    const rows = roomReplySteps(steps);
    expect(rows).toHaveLength(MAX_REPLY_STEPS);
    expect(rows[0]).toEqual({ kind: 'note', title: 'Note', text: 'Before the tools.' });
    expect(rows[1]).toMatchObject({ kind: 'tool', title: '2 earlier steps' });
    expect(rows.at(-1)).toMatchObject({ kind: 'tool', title: `t${MAX_REPLY_STEPS - 1}` });
  });

  it('keeps every note even when notes alone fill the bound', () => {
    const notes = Array.from({ length: MAX_REPLY_STEPS + 1 }, (_, index) => note(`n${index}`));
    const rows = roomReplySteps([...notes, tool('a')]);
    expect(rows.filter((row) => row.kind === 'note')).toHaveLength(MAX_REPLY_STEPS + 1);
    expect(rows.filter((row) => row.kind === 'tool')).toHaveLength(0);
  });
});
