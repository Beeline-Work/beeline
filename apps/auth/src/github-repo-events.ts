/**
 * GitHub repository activity events, extracted from verified webhook payloads.
 *
 * The signed webhook endpoint already receives every event the GitHub App is
 * subscribed to; this module turns the three shipped repository-activity event
 * types — stars, issues, and pull requests — into compact, bounded records the
 * auth service can store durably and later release to an authorized daemon.
 *
 * Deliberately narrow:
 *   - Three event types only (`star`, `issues`, `pull_request`). Anything else
 *     resolves `undefined` and the webhook acks it without storing.
 *   - Action filtering keeps Rooms readable: only the actions that change what
 *     a reader would want to know are stored. A busy repository's
 *     `labeled`/`assigned`/`synchronize` churn never reaches any Room.
 *   - One sentence per event, composed here so every reader of the stored
 *     record shows identical text. No plumbing, no raw payload ever stored.
 */
export type GitHubRepoEventType = 'star' | 'issues' | 'pull_request';

/** Actions worth a Room notice, per event type. Everything else stays silent. */
const REPORTED_ACTIONS: Record<GitHubRepoEventType, ReadonlySet<string>> = {
  star: new Set(['created', 'deleted']),
  issues: new Set(['opened', 'closed', 'reopened']),
  // `synchronize` fires on every push to an open PR and would drown a Room.
  pull_request: new Set(['opened', 'closed', 'reopened']),
};

export interface GitHubRepoEventRecord {
  /** Globally unique on GitHub, e.g. `owner/repo`. */
  fullName: string;
  eventType: GitHubRepoEventType;
  action: string;
  actor: string;
  /** Issue or pull request number; absent for stars. */
  number?: number;
  title?: string;
  url?: string;
  /** The exact one-line Room text for this event. */
  summary: string;
}

function repositoryFullName(body: Record<string, unknown>): string | undefined {
  const repository = body.repository;
  if (!repository || typeof repository !== 'object' || Array.isArray(repository)) return undefined;
  const fullName = (repository as Record<string, unknown>).full_name;
  if (typeof fullName !== 'string') return undefined;
  const trimmed = fullName.trim();
  return /^[^/\s]+\/[^/\s]+$/.test(trimmed) ? trimmed : undefined;
}

function actorLogin(body: Record<string, unknown>): string {
  const sender = body.sender;
  if (!sender || typeof sender !== 'object' || Array.isArray(sender)) return '';
  const login = (sender as Record<string, unknown>).login;
  return typeof login === 'string' ? login : '';
}

function htmlUrl(value: unknown): string | undefined {
  return typeof value === 'string' && value.startsWith('https://') ? value : undefined;
}

/**
 * Extract one storable record from a verified webhook payload, or `undefined`
 * when there is nothing to store: an unhandled event type, an unreported
 * action, or a malformed payload. Malformed never throws — GitHub retries
 * non-2xx deliveries, and a bad payload would not fix itself.
 */
export function extractGitHubRepoEvent(
  eventType: string,
  body: Record<string, unknown>,
): GitHubRepoEventRecord | undefined {
  if (eventType !== 'star' && eventType !== 'issues' && eventType !== 'pull_request') {
    return undefined;
  }
  const fullName = repositoryFullName(body);
  if (!fullName) return undefined;
  const action = typeof body.action === 'string' ? body.action : '';
  if (!REPORTED_ACTIONS[eventType].has(action)) return undefined;
  const actor = actorLogin(body);
  if (!actor) return undefined;

  if (eventType === 'star') {
    const summary =
      action === 'created'
        ? `${actor} starred ${fullName}`
        : `${actor} removed their star from ${fullName}`;
    return { fullName, eventType, action, actor, summary };
  }

  const key = eventType === 'issues' ? 'issue' : 'pull_request';
  const subject = body[key];
  if (!subject || typeof subject !== 'object' || Array.isArray(subject)) return undefined;
  const record = subject as Record<string, unknown>;
  const number = typeof record.number === 'number' && Number.isSafeInteger(record.number)
    ? record.number
    : undefined;
  const title = typeof record.title === 'string' ? record.title.trim() : '';
  if (number === undefined || !title) return undefined;
  const kind = eventType === 'issues' ? 'issue' : 'pull request';
  let verb: string;
  if (action === 'opened') verb = 'opened';
  else if (action === 'reopened') verb = 'reopened';
  else verb = eventType === 'pull_request' && record.merged === true ? 'merged' : 'closed';
  const suffix = `${kind} #${number} in ${fullName}: ${title}`;
  return {
    fullName,
    eventType,
    action,
    actor,
    number,
    title,
    ...(htmlUrl(record.html_url) ? { url: htmlUrl(record.html_url) } : {}),
    summary: `${actor} ${verb} ${suffix}`,
  };
}
