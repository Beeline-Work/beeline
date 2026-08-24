/** GitHub Events API ingestion normalized behind one source-neutral shape. */

export type RepositoryEventType = 'push' | 'pull-request' | 'issue' | 'ci' | 'review-comment';

export interface RepositoryEvent {
  source: 'github-poll';
  id: string;
  repository: string;
  type: RepositoryEventType;
  action: string;
  actor: string;
  actorType?: string;
  occurredAt: string;
  summary: string;
  url?: string;
  branch?: string;
}

export interface GitHubRepositoryTarget {
  owner: string;
  repo: string;
  installationId?: number;
  roomId: string;
}

export interface RepositoryEventPageResult {
  /** Newest raw event id currently visible for the repository. */
  head: string;
  /** Raw ids traversed since the prior cursor, including filtered noise. */
  sourceEventIds: string[];
  events: RepositoryEvent[];
}

export interface RepositoryEventSource {
  read(
    target: GitHubRepositoryTarget,
    cursor: string | undefined,
    options?: { coldLimit?: number; signal?: AbortSignal },
  ): Promise<RepositoryEventPageResult>;
}

type JsonRecord = Record<string, unknown>;

export const GITHUB_EVENT_TAG = 'github-event';
export const GITHUB_EVENT_HEALTH_TAG = 'github-event-health';
export const MAX_CARD_LINES = 10;
export const DEFAULT_GITHUB_EVENTS_REQUEST_TIMEOUT_MS = 15_000;
const MAX_PAGES = 10;
const PAGE_SIZE = 100;

function record(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function integer(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;
}

function httpsUrl(value: unknown): string | undefined {
  const candidate = string(value);
  return candidate && /^https:\/\/[^\s]+$/i.test(candidate) ? candidate : undefined;
}

function branchFromRef(value: unknown): string | undefined {
  return string(value)?.replace(/^refs\/heads\//, '');
}

function repoName(raw: JsonRecord): string | undefined {
  return string(record(raw.repo)?.name);
}

function actor(raw: JsonRecord): { login: string; type?: string } | undefined {
  const value = record(raw.actor);
  const login = string(value?.login);
  if (!login) return undefined;
  const type = string(value?.type);
  return { login, ...(type ? { type } : {}) };
}

function baseEvent(raw: JsonRecord):
  | (Pick<RepositoryEvent, 'source' | 'id' | 'repository' | 'actor' | 'occurredAt'> & {
      actorType?: string;
    })
  | undefined {
  const id = string(raw.id);
  const repository = repoName(raw);
  const who = actor(raw);
  const occurredAt = string(raw.created_at);
  if (!id || !repository || !who || !occurredAt) return undefined;
  return {
    source: 'github-poll',
    id,
    repository,
    actor: who.login,
    occurredAt,
    ...(who.type ? { actorType: who.type } : {}),
  };
}

/**
 * Normalize the exact quiet event set shipped by the service. Everything else
 * advances the source cursor silently so it cannot reappear on a later poll.
 */
export function normalizeGitHubEvent(value: unknown): RepositoryEvent | undefined {
  const raw = record(value);
  if (!raw) return undefined;
  const base = baseEvent(raw);
  const type = string(raw.type);
  const payload = record(raw.payload);
  if (!base || !type || !payload) return undefined;

  if (type === 'PushEvent') {
    const branch = branchFromRef(payload.ref);
    if (!branch) return undefined;
    const commits = Array.isArray(payload.commits) ? payload.commits.length : 0;
    const count = commits > 0 ? commits : (integer(payload.size) ?? 0);
    const url = httpsUrl(record(raw.repo)?.url)?.replace('api.github.com/repos/', 'github.com/');
    return {
      ...base,
      type: 'push',
      action: 'pushed',
      branch,
      summary: `${base.actor} pushed ${count} commit${count === 1 ? '' : 's'} to ${base.repository}:${branch}`,
      ...(url ? { url } : {}),
    };
  }

  if (type === 'PullRequestEvent') {
    const action = string(payload.action);
    if (action !== 'opened' && action !== 'closed' && action !== 'reopened') return undefined;
    const pull = record(payload.pull_request);
    const number = integer(payload.number) ?? integer(pull?.number);
    const title = string(pull?.title);
    if (number === undefined || !title) return undefined;
    const verb = action === 'closed' && pull?.merged === true ? 'merged' : action;
    return {
      ...base,
      type: 'pull-request',
      action: verb,
      summary: `${base.actor} ${verb} pull request #${number} in ${base.repository}: ${title}`,
      ...(httpsUrl(pull?.html_url) ? { url: httpsUrl(pull?.html_url) } : {}),
    };
  }

  if (type === 'IssuesEvent') {
    const action = string(payload.action);
    if (action !== 'opened' && action !== 'closed' && action !== 'reopened') return undefined;
    const issue = record(payload.issue);
    const number = integer(issue?.number);
    const title = string(issue?.title);
    if (number === undefined || !title || issue?.pull_request) return undefined;
    return {
      ...base,
      type: 'issue',
      action,
      summary: `${base.actor} ${action} issue #${number} in ${base.repository}: ${title}`,
      ...(httpsUrl(issue?.html_url) ? { url: httpsUrl(issue?.html_url) } : {}),
    };
  }

  if (type === 'PullRequestReviewCommentEvent') {
    if (string(payload.action) !== 'created') return undefined;
    const pull = record(payload.pull_request);
    const comment = record(payload.comment);
    const number = integer(pull?.number);
    const title = string(pull?.title);
    if (number === undefined || !title) return undefined;
    return {
      ...base,
      type: 'review-comment',
      action: 'created',
      summary: `${base.actor} commented on pull request #${number} in ${base.repository}: ${title}`,
      ...(httpsUrl(comment?.html_url) ? { url: httpsUrl(comment?.html_url) } : {}),
    };
  }

  if (type === 'WorkflowRunEvent') {
    if (string(payload.action) !== 'completed') return undefined;
    const workflow = record(payload.workflow_run);
    const conclusion = string(workflow?.conclusion);
    const name = string(workflow?.name) ?? 'Workflow';
    if (!conclusion) return undefined;
    const branch = string(workflow?.head_branch);
    return {
      ...base,
      type: 'ci',
      action: conclusion,
      summary: `${name} concluded ${conclusion} on ${base.repository}${branch ? `:${branch}` : ''}`,
      ...(branch ? { branch } : {}),
      ...(httpsUrl(workflow?.html_url) ? { url: httpsUrl(workflow?.html_url) } : {}),
    };
  }

  if (type === 'CheckRunEvent') {
    if (string(payload.action) !== 'completed') return undefined;
    const check = record(payload.check_run);
    const conclusion = string(check?.conclusion);
    const name = string(check?.name) ?? 'Check';
    if (!conclusion) return undefined;
    return {
      ...base,
      type: 'ci',
      action: conclusion,
      summary: `${name} concluded ${conclusion} on ${base.repository}`,
      ...(httpsUrl(check?.html_url) ? { url: httpsUrl(check?.html_url) } : {}),
    };
  }

  return undefined;
}

/** Bot branch pushes are plumbing; human pushes and bot target-branch pushes remain visible. */
export function isMutedRepositoryEvent(
  event: RepositoryEvent,
  targetBranches: ReadonlySet<string>,
): boolean {
  return (
    event.type === 'push' &&
    event.actorType?.toLowerCase() === 'bot' &&
    Boolean(event.branch && !targetBranches.has(event.branch))
  );
}

export function describeRepositoryEvents(events: readonly RepositoryEvent[]): string | undefined {
  if (events.length === 0) return undefined;
  const lines = events
    .slice(0, MAX_CARD_LINES)
    .map((event) =>
      events.length === 1 && event.url ? `${event.summary}\n${event.url}` : event.summary,
    );
  if (events.length > MAX_CARD_LINES) {
    lines.push(`… and ${events.length - MAX_CARD_LINES} more repository updates`);
  }
  return lines.join('\n');
}

function boundedSignal(parent: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return parent ? AbortSignal.any([parent, timeout]) : timeout;
}

/** GitHub REST source. A future webhook source implements RepositoryEventSource instead. */
export class GitHubEventsApiSource implements RepositoryEventSource {
  constructor(
    private readonly tokenFor: (target: GitHubRepositoryTarget) => Promise<string>,
    private readonly options: {
      apiBaseUrl?: string;
      requestTimeoutMs?: number;
      fetch?: typeof fetch;
    } = {},
  ) {}

  async read(
    target: GitHubRepositoryTarget,
    cursor: string | undefined,
    options: { coldLimit?: number; signal?: AbortSignal } = {},
  ): Promise<RepositoryEventPageResult> {
    const timeoutMs = this.options.requestTimeoutMs ?? DEFAULT_GITHUB_EVENTS_REQUEST_TIMEOUT_MS;
    const token = await Promise.race([
      this.tokenFor(target),
      new Promise<never>((_, reject) => {
        const timer = setTimeout(
          () =>
            reject(new Error(`GitHub installation token deadline exceeded after ${timeoutMs}ms`)),
          timeoutMs,
        );
        timer.unref?.();
      }),
    ]);
    const fetchImpl = this.options.fetch ?? fetch;
    // One deadline covers the complete paginated read. Creating a fresh
    // timeout per page would let an old cursor consume MAX_PAGES * timeoutMs
    // and could outrun the service watchdog even though every individual HTTP
    // request looked bounded.
    const requestSignal = boundedSignal(options.signal, timeoutMs);
    const rawNew: unknown[] = [];
    const sourceEventIds: string[] = [];
    let head = cursor ?? '';
    let foundCursor = false;

    for (let page = 1; page <= MAX_PAGES && !foundCursor; page += 1) {
      const url =
        `${this.options.apiBaseUrl ?? 'https://api.github.com'}/repos/` +
        `${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/events` +
        `?per_page=${PAGE_SIZE}&page=${page}`;
      const response = await fetchImpl(url, {
        signal: requestSignal,
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${token}`,
          'x-github-api-version': '2022-11-28',
          'user-agent': 'beeline-events',
        },
      });
      const body = (await response.json().catch(() => undefined)) as unknown;
      if (!response.ok || !Array.isArray(body)) {
        throw new Error(`GitHub events request failed: HTTP ${response.status}`);
      }
      if (page === 1) head = string(record(body[0])?.id) ?? cursor ?? '';
      for (const item of body) {
        const id = string(record(item)?.id);
        if (!id) continue;
        if (cursor && id === cursor) {
          foundCursor = true;
          break;
        }
        rawNew.push(item);
        sourceEventIds.push(id);
        if (!cursor && rawNew.length >= (options.coldLimit ?? 20)) {
          foundCursor = true;
          break;
        }
      }
      if (body.length < PAGE_SIZE) break;
    }

    // When an old cursor fell outside GitHub's retained window, cap the catch-up
    // just like cold start. Cursor advancement makes the truncation permanent.
    const limit = options.coldLimit ?? 20;
    const boundedRaw = cursor && !foundCursor ? rawNew.slice(0, limit) : rawNew;
    const boundedIds = cursor && !foundCursor ? sourceEventIds.slice(0, limit) : sourceEventIds;
    return {
      head,
      sourceEventIds: boundedIds,
      events: boundedRaw
        .map(normalizeGitHubEvent)
        .filter((event): event is RepositoryEvent => event !== undefined),
    };
  }
}
