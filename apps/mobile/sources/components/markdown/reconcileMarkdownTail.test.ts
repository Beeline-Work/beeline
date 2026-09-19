import { describe, expect, it } from 'vitest';
import { parseMarkdown } from './parseMarkdown';
import { reconcileMarkdownTail, type IncrementalMarkdownState } from './reconcileMarkdownTail';

describe('reconcileMarkdownTail', () => {
  it('matches a full parse across streaming block transitions', () => {
    const chunks = [
      '# Heading',
      '\nParagraph with **open',
      ' emphasis**',
      '\n- first',
      '\n- second',
      '\n\n| A | B |',
      '\n| --- | --- |',
      '\n| x | y |',
      '\n\n```ts',
      '\nconst answer = 42;',
      '\n```',
      '\n\n<options>',
      '\n<option>One</option>',
      '\n</options>',
    ];
    let markdown = '';
    let state: IncrementalMarkdownState | undefined;

    for (const chunk of chunks) {
      markdown += chunk;
      state = reconcileMarkdownTail(state, markdown);
      expect(state.blocks).toEqual(parseMarkdown(markdown));
    }
  });

  it('keeps settled block identities while replacing only the final block', () => {
    const before = ['First', 'Second', 'Draft'].join('\n');
    const initial = reconcileMarkdownTail(undefined, before);
    const next = reconcileMarkdownTail(initial, `${before} grows`);

    expect(next.blocks[0]).toBe(initial.blocks[0]);
    expect(next.blocks[1]).toBe(initial.blocks[1]);
    expect(next.blocks[2]).not.toBe(initial.blocks[2]);
    expect(next.stableBlocks).toBe(initial.stableBlocks);
    expect(next.blocks).toEqual(parseMarkdown(`${before} grows`));
  });

  it('falls back to a complete parse for a non-prefix rewrite', () => {
    const initial = reconcileMarkdownTail(undefined, 'First\nDraft');
    const rewritten = reconcileMarkdownTail(initial, 'Replacement\nBody');

    expect(rewritten.blocks).toEqual(parseMarkdown('Replacement\nBody'));
    expect(rewritten.blocks[0]).not.toBe(initial.blocks[0]);
  });
});
