import { describe, expect, it } from 'vitest';
import {
  composerFieldSelection,
  removeComposerTag,
  removeLastComposerTag,
  splitComposerTags,
  toggleComposerTag,
} from './composer-tags';

const agents = new Set(['ruby', 'sol']);

describe('composer tags', () => {
  it('reads leading agent tags as chips and keeps the typed rest', () => {
    expect(splitComposerTags('@ruby @sol make it smaller', agents)).toEqual({
      tags: ['ruby', 'sol'],
      prefix: '@ruby @sol ',
      rest: 'make it smaller',
    });
    expect(splitComposerTags('@ruby ', agents)).toEqual({
      tags: ['ruby'],
      prefix: '@ruby ',
      rest: '',
    });
  });

  it('stops at the first token that is not a whole agent tag', () => {
    expect(splitComposerTags('@ruby', agents).tags).toEqual([]);
    expect(splitComposerTags('@lunchbox @ruby hi', agents).tags).toEqual([]);
    expect(splitComposerTags('hi @ruby ', agents).tags).toEqual([]);
    expect(splitComposerTags('@ruby\nhi', agents).tags).toEqual([]);
    expect(splitComposerTags('@ruby hi', new Set()).tags).toEqual([]);
  });

  it('removes one chip or the last chip and keeps the typed text exactly', () => {
    expect(removeComposerTag('@ruby @sol two  spaces', agents, 'ruby')).toBe('@sol two  spaces');
    expect(removeLastComposerTag('@ruby @sol hi', agents)).toBe('@ruby hi');
    expect(removeLastComposerTag('@ruby ', agents)).toBe('');
    expect(removeLastComposerTag('hi', agents)).toBe('hi');
  });

  it('toggles a tag after the existing chips, so the sent text starts with every tag', () => {
    expect(toggleComposerTag('', agents, 'ruby')).toBe('@ruby ');
    expect(toggleComposerTag('@ruby hi', agents, 'sol')).toBe('@ruby @sol hi');
    expect(toggleComposerTag('@ruby @sol hi', agents, 'ruby')).toBe('@sol hi');
  });

  it('maps a whole-text selection to the field after the chips', () => {
    expect(composerFieldSelection('@ruby hello', agents, { start: 11, end: 11 })).toEqual({
      start: 5,
      end: 5,
    });
    expect(composerFieldSelection('@ruby ', agents, { start: 3, end: 3 })).toEqual({
      start: 0,
      end: 0,
    });
  });
});
