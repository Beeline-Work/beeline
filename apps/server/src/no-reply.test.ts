import { expect, it } from 'vitest';
import { isNoReplyDeclaration } from './no-reply.js';

it.each([
  'I posted nothing.', 'Nothing to post…', 'I haven’t posted to the Room or corner.',
  "I won't post anything to this corner.", 'NO_REPLY', '[NO_REPLY]', 'No reply needed.',
  'Nothing to post here. I have not posted anything.',
  'No Room or corner post is needed.', "Nothing new to post. I'll stay quiet.",
  'I am not posting anything in the Room.',
])('recognizes the complete silence declaration: %s', text => {
  expect(isNoReplyDeclaration(text)).toBe(true);
});

it.each([
  '', 'I posted nothing because authentication failed. Please sign in.',
  'The fixture contains "Nothing to post".', 'Nothing to report about CI; fix the missing permissions.',
  "I won't post the credentials. The build passed.", 'No reply needed? Why?',
])('retains answers carrying facts or requests: %s', text => {
  expect(isNoReplyDeclaration(text)).toBe(false);
});
