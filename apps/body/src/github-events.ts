/** GitHub Events API ingestion normalized behind one source-neutral shape. */

/** The deliberately small GitHub activity vocabulary that Rooms display. */
export type RepositoryEventType = 'pull-request' | 'issue' | 'lifecycle-hint';
export type RepositoryEventAction = 'opened' | 'closed' | 'merged' | 'synchronize' | 'target-push';

export interface RepositoryEvent {
  source: 'github-poll';
  id: string;
  repository: string;
  type: RepositoryEventType;
  action: RepositoryEventAction;
  actor: string;
  occurredAt: string;
  title?: string;
  url?: string;
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

function httpsUrl(value: unknown): string | undefined {
  const candidate = string(value);
  return candidate && /^https:\/\/[^\s]+$/i.test(candidate) ? candidate : undefined;
}

function repoName(raw: JsonRecord): string | undefined {
  return string(record(raw.repo)?.name);
}

function actor(raw: JsonRecord): string | undefined {
  const value = record(raw.actor);
  const login = string(value?.login);
  return login;
}

function baseEvent(
  raw: JsonRecord,
): Pick<RepositoryEvent, 'source' | 'id' | 'repository' | 'actor' | 'occurredAt'> | undefined {
  const id = string(raw.id);
  const repository = repoName(raw);
  const who = actor(raw);
  const occurredAt = string(raw.created_at);
  if (!id || !repository || !who || !occurredAt) return undefined;
  return {
    source: 'github-poll',
    id,
    repository,
    actor: who,
    occurredAt,
  };
}

/**
 * Normalize the exact Room-card event set. Everything else, including pushes,
 * advances the source cursor silently so it cannot reappear on a later poll.
 */
export function normalizeGitHubEvent(value: unknown): RepositoryEvent | undefined {
  const raw = record(value);
  if (!raw) return undefined;
  const base = baseEvent(raw);
  const type = string(raw.type);
  const payload = record(raw.payload);
  if (!base || !type || !payload) return undefined;

  if (type === 'PullRequestEvent') {
    const action = string(payload.action);
    const pull = record(payload.pull_request);
    if (action === 'synchronize') {
      return { ...base, type: 'lifecycle-hint', action };
    }
    if (action !== 'opened' && action !== 'closed') return undefined;
    const title = string(pull?.title);
    const url = httpsUrl(pull?.html_url);
    if (!title || !url) return undefined;
    const verb: RepositoryEventAction =
      action === 'closed' && pull?.merged === true ? 'merged' : action;
    return {
      ...base,
      type: 'pull-request',
      action: verb,
      title,
      url,
    };
  }

  if (type === 'PushEvent') {
    const ref = string(payload.ref);
    if (!ref?.startsWith('refs/heads/')) return undefined;
    return { ...base, type: 'lifecycle-hint', action: 'target-push' };
  }

  if (type === 'IssuesEvent') {
    const action = string(payload.action);
    if (action !== 'opened' && action !== 'closed') return undefined;
    const issue = record(payload.issue);
    const title = string(issue?.title);
    const url = httpsUrl(issue?.html_url);
    if (!title || !url || issue?.pull_request) return undefined;
    return {
      ...base,
      type: 'issue',
      action,
      title,
      url,
    };
  }

  return undefined;
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
