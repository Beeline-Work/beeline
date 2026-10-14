import { expect, it } from 'vitest';
import { normalizeTrayAsk, plainAsk, shortenAsk } from './tray-ask.js';

it('requires a plain single sentence on one line within 140 characters', () => {
  expect(normalizeTrayAsk('Turn Feedback Fixed notices on or off?')).toBe('Turn Feedback Fixed notices on or off?');
  for (const value of [undefined, '', '**Approve** it?', 'Approve it?\nNow?', 'Approve it? Why?', 'x'.repeat(141)])
    expect(() => normalizeTrayAsk(value)).toThrow();
  expect(normalizeTrayAsk('x'.repeat(140))).toHaveLength(140);
});
it('removes markdown and shortens long hashes without losing the start', () => {
  expect(plainAsk('**Approve** [PR #2412](https://example.test/2412) at `' + 'a'.repeat(40) + '`?'))
    .toBe('Approve PR #2412 at aaaaaaa?');
  const ask = shortenAsk('Approve merge of PR #2412: ' + 'long title '.repeat(30));
  expect(ask).toMatch(/^Approve merge of PR #2412:/);
  expect(Array.from(ask).length).toBeLessThanOrEqual(140);
  expect(ask.endsWith('…')).toBe(true);
});
