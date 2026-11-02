import { systemMessage } from '@beeline/api-contract/system-message-catalog';
import type { SystemEvent } from '@beeline/api-contract/phone';

/** Display only; the signed delivery payload and wake policy remain unchanged. */
export function repositorySubscriptionLine(
  event: string, repository: string, details?: Record<string, unknown>,
): Pick<SystemEvent, 'subject' | 'verb' | 'object' | 'consequence'> {
  const verbs: Record<string, string> = {
    'issue.opened': systemMessage("repository-subscription-line.opened-issue"), 'issue.closed': systemMessage("repository-subscription-line.closed-issue"),
    'issue.reopened': systemMessage("repository-subscription-line.reopened-issue"), 'pull_request.opened': systemMessage("repository-subscription-line.opened-pull-request"),
    'pull_request.closed': details?.merged === true ? systemMessage("repository-subscription-line.merged-pull-request") : systemMessage("repository-subscription-line.closed-pull-request"),
    'pull_request.reopened': systemMessage("repository-subscription-line.reopened-pull-request"),
    'star.created': systemMessage("repository-subscription-line.starred"), 'star.deleted': systemMessage("repository-subscription-line.unstarred"),
  };
  const title = typeof details?.title === 'string'
    ? details.title.replace(/https?:\/\/\S+/gi, '').replace(/[:\r\n\s]+/g, systemMessage("repository-subscription-line.space")).trim() : '';
  const shortTitle = title.length > 80 ? systemMessage("repository-subscription-line.clipped-title", title.slice(0, 79).trimEnd()) : title;
  const number = typeof details?.number === 'number' && Number.isSafeInteger(details.number)
    ? systemMessage("repository-subscription-line.item-number", details.number) : '';
  const star = event.startsWith('star.');
  return {
    subject: { kind: 'github', name: systemMessage("repository-subscription-line.github") },
    verb: verbs[event]!,
    object: {
      text: star ? repository : [number, shortTitle].filter(Boolean).join(systemMessage("repository-subscription-line.space")) || repository,
      url: !star && typeof details?.html_url === 'string'
        ? details.html_url.slice(0, 500) : `https://github.com/${repository}`,
    },
    consequence: repository,
  };
}
