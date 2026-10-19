import { describe, expect, it } from 'vitest';
import type { AgentTurnStep } from './acp.js';
import { MAX_NOTE_LENGTH, MAX_REPLY_STEPS, roomReplySteps } from './room-turn-steps.js';

const note = (text: string): AgentTurnStep => ({ kind: 'note', text });
const tool = (title: string): AgentTurnStep => ({
  kind: 'tool',
  call: { id: title, title, kind: 'other', status: 'completed' },
});

describe('roomReplySteps', () => {
  it('keeps every note whole and in order between the tools', () => {
    const long = 'x'.repeat(MAX_NOTE_LENGTH);
    expect(roomReplySteps([note('First.'), tool('a'), note(long), tool('b')])).toEqual([
      { kind: 'note', title: 'Note', text: 'First.' },
      expect.objectContaining({ kind: 'tool', title: 'a' }),
      { kind: 'note', title: 'Note', text: long },
      expect.objectContaining({ kind: 'tool', title: 'b' }),
    ]);
  });

  it('folds the oldest tools, never a note, when the steps exceed the bound', () => {
    const steps = [
      note('Before the tools.'),
      ...Array.from({ length: MAX_REPLY_STEPS }, (_, index) => tool(`t${index}`)),
    ];
    const rows = roomReplySteps(steps)!;
    expect(rows).toHaveLength(MAX_REPLY_STEPS);
    expect(rows[0]).toEqual({ kind: 'note', title: 'Note', text: 'Before the tools.' });
    expect(rows[1]).toMatchObject({ kind: 'tool', title: '2 earlier steps' });
    expect(rows[2]).toMatchObject({ kind: 'tool', title: 't2' });
    expect(rows.at(-1)).toMatchObject({ kind: 'tool', title: `t${MAX_REPLY_STEPS - 1}` });
  });

  it('refuses rather than cut a note longer than the bound', () => {
    expect(roomReplySteps([note('x'.repeat(MAX_NOTE_LENGTH + 14)), tool('a')])).toBeUndefined();
  });

  it('refuses rather than drop notes when the notes alone exceed the bound', () => {
    const notes = Array.from({ length: MAX_REPLY_STEPS }, (_, index) => note(`n${index}`));
    expect(roomReplySteps(notes)).toHaveLength(MAX_REPLY_STEPS);
    expect(roomReplySteps([...notes, tool('a')])).toBeUndefined();
    expect(roomReplySteps([...notes, note('one more')])).toBeUndefined();
  });
});
