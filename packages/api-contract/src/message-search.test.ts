import { describe, expect, it } from 'vitest';
import { MESSAGE_SEARCH_FILLER_WORDS, messageSearchTerms } from './message-search.js';

describe('messageSearchTerms', () => {
  it('matches earlier words whole and the last word as a prefix, without punctuation', () => {
    expect(messageSearchTerms('Android bui')).toBe("'android'");
    expect(messageSearchTerms('Android buil')).toBe("'android' & 'buil':*");
    expect(messageSearchTerms("x' | yyyy:* & !zzzz")).toBe("'x' & 'yyyy' & 'zzzz':*");
  });

  it('needs four characters in the word still being typed, but keeps a short earlier word', () => {
    expect(messageSearchTerms('andr')).toBe("'andr':*");
    expect(messageSearchTerms('and')).toBeNull();
    expect(messageSearchTerms('ci')).toBeNull();
    expect(messageSearchTerms('ci build')).toBe("'ci' & 'build':*");
    expect(messageSearchTerms('ci bu')).toBe("'ci'");
  });

  it('never searches a filler word, whole or as a prefix', () => {
    for (const word of ['the', 'and', 'that', 'this', 'with', 'have', 'from', 'they', 'what', 'when', 'your', 'there', 'about', 'would', 'been', 'were', 'just', 'like', 'okay', 'yeah', 'thanks'])
      expect(MESSAGE_SEARCH_FILLER_WORDS).toContain(word);
    expect(messageSearchTerms('with')).toBeNull();
    expect(messageSearchTerms('The build')).toBe("'build':*");
    expect(messageSearchTerms('build with')).toBe("'build'");
    expect(messageSearchTerms("Don't have that")).toBeNull();
  });

  it('is null when nothing searchable remains', () => {
    expect(messageSearchTerms('')).toBeNull();
    expect(messageSearchTerms('   ')).toBeNull();
    expect(messageSearchTerms('!!! ???')).toBeNull();
    expect(messageSearchTerms('yeah thanks for that')).toBeNull();
  });

  it('caps a long query at eight terms', () => {
    expect(messageSearchTerms('aa bb cc dd ee ff gg hh ii jj kkkk')?.split(' & ')).toEqual([
      "'aa'", "'bb'", "'cc'", "'dd'", "'ee'", "'ff'", "'gg'", "'hh'",
    ]);
  });
});
