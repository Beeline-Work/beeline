import { expect, it } from 'vitest';
import { turnMessageRepetition } from './turn-repetition.js';
const post = 'Google sign-in (#2676) is merged. The checks passed and the account linking flow is ready for review.';
it.each([
  [post, true],
  [post.toUpperCase().replaceAll(' ', '\n'), true],
  ['Google sign-in (#2676) is merged.', true],
  [post.replace('ready for review', 'available for review'), true],
  [`${post} You must approve the release.`, false],
  [post.replace('passed', 'failed'), false],
  [post.replace('ready', 'deleted'), false],
  [post.replace('2676', '2677'), false],
  ['The release is pending.', false],
  ['', false],
])('compares conservatively: %s', (final, expected) => {
  expect(Boolean(turnMessageRepetition(final, post))).toBe(expected);
});

it.each([['Balance is -5.', 'Balance is 5.'], ['Open https://example.com/a-b', 'Open https://example.com/a/b']])('preserves changed literal %s', (final, previous) => {
  expect(turnMessageRepetition(final, previous)).toBe(false);
});
