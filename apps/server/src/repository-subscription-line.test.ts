import { expect, it } from 'vitest';
import { composeSystemLine } from './system-line.js';
import { repositorySubscriptionLine } from './repository-subscription-line.js';

it.each([
  ['issue.opened', 'opened issue'], ['issue.closed', 'closed issue'],
  ['issue.reopened', 'reopened issue'], ['pull_request.opened', 'opened pull request'],
  ['pull_request.closed', 'closed pull request'], ['pull_request.reopened', 'reopened pull request'],
  ['star.created', 'starred'], ['star.deleted', 'unstarred'],
])('composes linked GitHub text and event for %s', (event, verb) => {
  const star = event.startsWith('star.');
  const object = { text: star ? 'owner/repo' : '#7 Fix campaigns',
    url: star ? 'https://github.com/owner/repo' : 'https://github.com/owner/repo/issues/7' };
  const result = composeSystemLine({
    ...repositorySubscriptionLine(event, 'owner/repo', {
      number: 7, title: 'Fix campaigns', html_url: object.url,
    }), kind: 'subscription-fired',
  });
  expect(result.text).toBe(`GitHub ${verb} ${object.text} · owner/repo`);
  expect(result.event).toEqual({ subject: { kind: 'github', name: 'GitHub' },
    verb, object, consequence: 'owner/repo', kind: 'subscription-fired' });
});

it('composes merged pull request wording without changing delivery policy', () => {
  const result = composeSystemLine({ ...repositorySubscriptionLine('pull_request.closed', 'owner/repo', {
    number: 9, title: 'Fix campaigns', merged: true, html_url: 'https://github.com/owner/repo/pull/9',
  }), kind: 'subscription-fired' });
  expect(result.text).toBe('GitHub merged pull request #9 Fix campaigns · owner/repo');
  expect(result.event.object).toEqual({ text: '#9 Fix campaigns', url: 'https://github.com/owner/repo/pull/9' });
  expect(result.event.verb).toBe('merged pull request');
});

it('bounds and cleans outside titles while retaining the link', () => {
  const result = composeSystemLine(repositorySubscriptionLine('issue.opened', 'owner/repo', {
    number: 7, title: `Fix:\n campaigns https://example.test/secret ${'x'.repeat(200)}`,
    html_url: 'https://github.com/owner/repo/issues/7',
  }));
  expect(result.event.object!.text).toHaveLength(83);
  expect(result.event.object!.text).toMatch(/^#7 Fix campaigns .*…$/);
  expect(result.text).not.toMatch(/[\r\n:]|https?:/);
});
