import { describe, expect, it } from 'vitest';
import {
  composerBackspaceCursor,
  deleteComposerTagBackward,
  roomComposerTagHandles,
  splitComposerTags,
} from './composer-tags';

const agents = new Set(['ruby', 'sol', 'speedy']);

describe('composer tags', () => {
  it('recognizes handles of every current Room member, including people', () => {
    const handles = roomComposerTagHandles([
      { kind: 'person', handle: 'bananaman614305' },
      { kind: 'agent', handle: 'ruby' },
    ]);
    expect(splitComposerTags('@bananaman614305 ', handles)).toEqual({
      tags: ['bananaman614305'],
      prefix: '@bananaman614305 ',
      rest: '',
    });
    expect(splitComposerTags('@bananaman614305 hello', handles).rest).toBe('hello');
    expect(splitComposerTags('@outsider ', handles).tags).toEqual([]);
  });

  it('reads leading member tags and keeps the typed rest', () => {
    expect(splitComposerTags('@ruby @sol make it smaller', agents)).toEqual({
      tags: ['ruby', 'sol'],
      prefix: '@ruby @sol ',
      rest: 'make it smaller',
    });
  });

  it('stops at the first token that is not a whole member tag', () => {
    expect(splitComposerTags('@ruby', agents).tags).toEqual([]);
    expect(splitComposerTags('@lunchbox @ruby hi', agents).tags).toEqual([]);
    expect(splitComposerTags('hi @ruby ', agents).tags).toEqual([]);
    expect(splitComposerTags('@ruby hi', new Set()).tags).toEqual([]);
  });
});

describe('one backspace deletes a whole tag', () => {
  it('deletes a tag at the start, in the middle and at the end of the message', () => {
    expect(deleteComposerTagBackward('@ruby make it smaller', 5, agents)).toEqual({
      text: ' make it smaller',
      cursor: 0,
    });
    expect(deleteComposerTagBackward('@ruby and @speedy look', 17, agents)).toEqual({
      text: '@ruby and  look',
      cursor: 10,
    });
    expect(deleteComposerTagBackward('thanks @sol', 11, agents)).toEqual({
      text: 'thanks ',
      cursor: 7,
    });
  });

  it('empties a field that holds only the tag', () => {
    expect(deleteComposerTagBackward('@ruby', 5, agents)).toEqual({ text: '', cursor: 0 });
  });

  it('ends at a tag followed by punctuation or a new line', () => {
    expect(deleteComposerTagBackward('@ruby, hi', 5, agents)).toEqual({ text: ', hi', cursor: 0 });
    expect(deleteComposerTagBackward('@ruby. ok', 5, agents)).toEqual({ text: '. ok', cursor: 0 });
    expect(deleteComposerTagBackward('hi\n@sol\nnext', 7, agents)).toEqual({
      text: 'hi\n\nnext',
      cursor: 3,
    });
    expect(deleteComposerTagBackward('(@sol)', 5, agents)).toEqual({ text: '()', cursor: 1 });
  });

  it('leaves the space after a tag to an ordinary backspace', () => {
    expect(deleteComposerTagBackward('@ruby ', 6, agents)).toBeNull();
    expect(deleteComposerTagBackward('@ruby hi', 6, agents)).toBeNull();
  });

  it('deletes one letter of a handle that is no Room member, or of a longer word', () => {
    expect(deleteComposerTagBackward('@spee', 5, agents)).toBeNull();
    expect(deleteComposerTagBackward('@lunchbox hi', 9, agents)).toBeNull();
    expect(deleteComposerTagBackward('@rubyx', 6, agents)).toBeNull();
    expect(deleteComposerTagBackward('@rubyx', 5, agents)).toBeNull();
    expect(deleteComposerTagBackward('@ruby.dev', 5, agents)).toBeNull();
    expect(deleteComposerTagBackward('@rub', 4, agents)).toBeNull();
    expect(deleteComposerTagBackward('mail me@ruby', 12, agents)).toBeNull();
    expect(deleteComposerTagBackward('@ruby', 5, new Set())).toBeNull();
    expect(deleteComposerTagBackward('', 0, agents)).toBeNull();
  });

  it('matches a tag typed in capitals', () => {
    expect(deleteComposerTagBackward('@Ruby hi', 5, agents)).toEqual({ text: ' hi', cursor: 0 });
  });
});

describe('reading a native backspace from the text', () => {
  const caret = (at: number) => ({ start: at, end: at });

  it('finds the cursor a one-character backspace was pressed at', () => {
    expect(composerBackspaceCursor('@ruby hi', '@rub hi', caret(5))).toBe(5);
    // The selection may already have moved for this change.
    expect(composerBackspaceCursor('@ruby hi', '@rub hi', caret(4))).toBe(5);
    expect(composerBackspaceCursor('@ann hi', '@an hi', caret(3))).toBe(4);
  });

  it('ignores typing, pastes, replacements and a deleted one-character selection', () => {
    expect(composerBackspaceCursor('@rub', '@ruby', caret(4))).toBeNull();
    expect(composerBackspaceCursor('@ruby hi', '@ruby', caret(8))).toBeNull();
    expect(composerBackspaceCursor('@ruby hi', '@ruby ho', caret(8))).toBeNull();
    expect(composerBackspaceCursor('@ruby hi', '@rub hi', { start: 4, end: 5 })).toBeNull();
  });
});
