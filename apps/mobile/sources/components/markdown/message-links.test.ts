import { describe, expect, it } from 'vitest';
import { parseMarkdownSpans } from './parseMarkdownSpans';

const target = `#beeline/repo-clutter-sweep/${'a'.repeat(64)}`;

describe('message links', () => {
  it.each(['.', ',', ')'])('leaves trailing %s outside bare links', (punctuation) => {
    expect(parseMarkdownSpans(`See ${target}${punctuation}`, false)).toEqual([
      { text: 'See ', styles: [], url: null },
      { text: target, styles: [], url: target },
      { text: punctuation, styles: [], url: null },
    ]);
  });
  it('renders a Markdown label and preserves inline code', () => {
    expect(parseMarkdownSpans(`[approval card](${target})`, false)).toEqual([
      { text: 'approval card', styles: [], url: target },
    ]);
    expect(parseMarkdownSpans('`' + target + '`', false)[0]?.url).toBeNull();
  });
  it.each([target + 'a', target.slice(0, -1), 'word' + target])('does not autolink an invalid token %s', (text) => {
    expect(parseMarkdownSpans(text, false).some((span) => span.url)).toBe(false);
  });
});
