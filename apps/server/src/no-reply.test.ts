import { expect, it } from 'vitest';
import { isNoReplyDeclaration, isPostedWaitingNarration, isReportStatusPrefixed } from './no-reply.js';

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
  'Nonhuman wake only. I checked the corner and it is still running.',
])('retains answers carrying facts or requests: %s', text => {
  expect(isNoReplyDeclaration(text)).toBe(false);
});

it.each([
  'Nonhuman wake only … Ending silently',
  'Nonhuman wake only — ending silently.',
  'Ending silently.',
])('recognizes wake-silence narration: %s', text => {
  expect(isNoReplyDeclaration(text)).toBe(true);
});

it.each([
  'Posted a concise Arabic list … Waiting for Mohammed',
  'Posted the roster to the wall. Waiting for signatures.',
  'Posted a draft — waiting for the merge',
])('recognizes posted-then-waiting narration as internal status: %s', text => {
  expect(isPostedWaitingNarration(text)).toBe(true);
});

it.each([
  'Posted the list you asked for. Should I also share it with the others?',
  'The list was posted above; waiting for your word.',
  'I finished the report.',
  'blocked: Corner release is idle with no worker schedule or event subscription',
])('keeps real replies that merely mention posting or waiting: %s', text => {
  expect(isPostedWaitingNarration(text)).toBe(false);
});

it('matches report-status prefixes on worker-status final text', () => {
  expect(isReportStatusPrefixed(
    'blocked: Corner release is idle with no worker schedule or event subscription',
  )).toBe(true);
  expect(isReportStatusPrefixed('The corner is idle again, sadly')).toBe(false);
});
