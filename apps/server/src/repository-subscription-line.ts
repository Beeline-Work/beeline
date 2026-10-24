import type { SystemEvent } from '@beeline/api-contract/phone';

/** Display only; the signed delivery payload and wake policy remain unchanged. */
export function repositorySubscriptionLine(
  event: string, repository: string, details?: Record<string, unknown>,
): Pick<SystemEvent, 'subject' | 'verb' | 'object' | 'consequence'> {
  const verbs: Record<string, string> = {
    'issue.opened': 'opened issue', 'issue.closed': 'closed issue',
    'issue.reopened': 'reopened issue', 'pull_request.opened': 'opened pull request',
    'pull_request.closed': details?.merged === true ? 'merged pull request' : 'closed pull request',
    'pull_request.reopened': 'reopened pull request',
    'star.created': 'starred', 'star.deleted': 'unstarred',
  };
  const title = typeof details?.title === 'string'
    ? details.title.replace(/https?:\/\/\S+/gi, '').replace(/[:\r\n\s]+/g, ' ').trim() : '';
  const shortTitle = title.length > 80 ? `${title.slice(0, 79).trimEnd()}…` : title;
  const number = typeof details?.number === 'number' && Number.isSafeInteger(details.number)
    ? `#${details.number}` : '';
  const star = event.startsWith('star.');
  return {
    subject: { kind: 'github', name: 'GitHub' },
    verb: verbs[event]!,
    object: {
      text: star ? repository : [number, shortTitle].filter(Boolean).join(' ') || repository,
      url: !star && typeof details?.html_url === 'string'
        ? details.html_url.slice(0, 500) : `https://github.com/${repository}`,
    },
    consequence: repository,
  };
}
