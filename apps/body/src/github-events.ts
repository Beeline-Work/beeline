/**
 * GitHub repository activity, delivered into the Rooms bound to that repo.
 *
 * The hop: a verified webhook lands on the auth service (the only inbound-
 * reachable piece), which stores it durably per repository. Room daemons
 * connect only OUTWARD — to the relay and to the auth service — so each served
 * Room long-polls `/auth/github/room-events` from this loop. The endpoint's
 * authority is the same one that mints Room installation tokens: current relay
 * truth must show this agent inside a Room whose admin-authored binding names
 * the repository, so private repository activity can never reach a Room whose
 * members should not see it.
 *
 * Delivery properties, all deliberate:
 *   - ON by default for stars, issues, and pull requests; an admin can turn
 *     the feed off per Room via the room-repository config record
 *     (`githubEventsEnabled`, carried by `setRoomGitHubEvents`). While off,
 *     nothing is fetched; on re-enable, anything inside retention arrives late.
 *   - A daemon that was offline when an event arrived catches up from its
 *     persisted cursor — delivered late, never silently skipped.
 *   - Duplicate deliveries are collapsed twice: the auth service stores at
 *     most one row per `x-github-delivery`, and the cursor advances only after
 *     the Room card actually published.
 *   - A busy repository cannot drown a Room: events fetched together post as
 *     ONE compact card capped at MAX_CARD_LINES, with an overflow count.
 *
 * The loop is entirely best-effort: it never throws into its caller, backs off
 * with jitter on failure, and stops permanently (one console line) if the
 * relay's auth service does not expose the feed at all.
 */
import { getGitHubRoomEvents, type Identity } from '@beeline/buzz-client';

/** One stored repository event as released by the auth service. */
export interface GitHubRepoEvent {
  id: number;
  type: string;
  action: string;
  actor: string;
  summary: string;
  received_at?: string;
  number?: number;
  title?: string;
  url?: string;
}

/** Max event lines in one Room card before the rest collapse into a count. */
export const MAX_CARD_LINES = 10;

/**
 * The compact ambient card for a batch of stored repository events, or
 * `undefined` when there is nothing to say. Matches the CI-watch precedent:
 * plain one-line facts, no plumbing. One event carries its link; a batch is
 * one card of bare lines so a burst lands as one readable notice, not a flood.
 */
export function describeGitHubRepoEvents(events: readonly GitHubRepoEvent[]): string | undefined {
  if (events.length === 0) return undefined;
  const lines = events.slice(0, MAX_CARD_LINES).map((event) =>
    // A lone event gets its link; a batch stays compact without them.
    events.length === 1 && event.url ? `${event.summary}\n${event.url}` : event.summary,
  );
  if (events.length > MAX_CARD_LINES) {
    lines.push(`… and ${events.length - MAX_CARD_LINES} more repository updates`);
  }
  return lines.join('\n');
}

const RETRYABLE_POST_ATTEMPTS = 3;

export interface GitHubEventWatcherDeps {
  roomId: string;
  /** Resolved `owner/repo` for this Room's bound GitHub repository. */
  fullName: string;
  identity: Pick<Identity, 'secretKey' | 'publicKey'>;
  /** Auth-service base URL (in production, the relay origin serving /auth). */
  baseUrl: string;
  /** Per-Room toggle; absent config means enabled. */
  eventsEnabled: () => Promise<boolean>;
  /** Publish the composed card into the Room. */
  post: (text: string) => Promise<void>;
  loadCursor: () => Promise<number | undefined>;
  saveCursor: (id: number) => Promise<void>;
  signal?: AbortSignal;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  fetchEvents?: typeof getGitHubRoomEvents;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    timer.unref?.();
    function finish(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    }
    signal?.addEventListener('abort', finish, { once: true });
  });
}

/** +/-25% jitter, matching RoomPollBackoff's convention. */
function jitter(ms: number): number {
  return Math.round(ms * (0.75 + Math.random() * 0.5));
}

const POLL_WAIT_MS = 25_000;
const RETRY_RETRY_DELAY_MS = 1_000;
const TOGGLE_RECHECK_MS = 5 * 60_000;
const ERROR_BACKOFF_BASE_MS = 5_000;
const ERROR_BACKOFF_MAX_MS = 5 * 60_000;

/**
 * Run one Room's repository-event feed until aborted. Never throws: every
 * failure is backed off and retried, except a permanently unavailable feed,
 * which logs once and ends the loop.
 */
export async function runGitHubEventWatcher(deps: GitHubEventWatcherDeps): Promise<void> {
  const fetchEvents = deps.fetchEvents ?? getGitHubRoomEvents;
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? Date.now;
  let backoffMs = ERROR_BACKOFF_BASE_MS;
  let loggedUnavailable = false;
  let pendingBatch: GitHubRepoEvent[] = [];
  let pendingAttempts = 0;

  while (!deps.signal?.aborted) {
    try {
      // While the toggle is OFF nothing is fetched and the cursor is frozen:
      // re-enabling later resumes exactly where the feed stopped, bounded by
      // server-side retention.
      if (!(await deps.eventsEnabled())) {
        await sleep(TOGGLE_RECHECK_MS, deps.signal);
        continue;
      }

      if (pendingBatch.length > 0) {
        // Retry an unpublished batch before fetching more, so ordering holds.
        pendingAttempts += 1;
        if (pendingAttempts > RETRYABLE_POST_ATTEMPTS) {
          console.error(
            `[body] GitHub events: dropping ${pendingBatch.length} undeliverable event(s) for Room ${deps.roomId} after ${pendingAttempts - 1} attempts`,
          );
          await deps.saveCursor(pendingBatch[pendingBatch.length - 1]!.id);
          pendingBatch = [];
          pendingAttempts = 0;
          continue;
        }
        const text = describeGitHubRepoEvents(pendingBatch);
        if (text) {
          try {
            await deps.post(text);
          } catch (error) {
            // Stay on the bounded-retry path below; never leak into the
            // generic backoff handler, which would stall the feed.
            console.error(
              `[body] GitHub events: posting to Room ${deps.roomId} failed (will retry):`,
              error,
            );
            await sleep(RETRY_RETRY_DELAY_MS, deps.signal);
            continue;
          }
        }
        await deps.saveCursor(pendingBatch[pendingBatch.length - 1]!.id);
        pendingBatch = [];
        pendingAttempts = 0;
        continue;
      }

      let cursor = await deps.loadCursor();
      const bootstrapping = cursor === undefined;
      if (bootstrapping) {
        // First contact: start from NOW rather than replaying retained history
        // into a Room that never asked for old news. Offline catch-up applies
        // to daemons that have served the Room before (they have a cursor).
        const bootstrap = await fetchEvents(deps.baseUrl, deps.identity, deps.roomId);
        await deps.saveCursor(bootstrap.cursor);
        cursor = bootstrap.cursor;
      }

      const result = await fetchEvents(deps.baseUrl, deps.identity, deps.roomId, {
        since: cursor,
        waitMs: POLL_WAIT_MS,
      });
      if (result.events.length > 0) {
        const text = describeGitHubRepoEvents(result.events);
        if (text) {
          try {
            await deps.post(text);
          } catch (error) {
            pendingBatch = result.events;
            pendingAttempts = 1;
            console.error(
              `[body] GitHub events: posting to Room ${deps.roomId} failed (will retry):`,
              error,
            );
            continue;
          }
        }
        await deps.saveCursor(result.cursor);
      }
      backoffMs = ERROR_BACKOFF_BASE_MS;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!loggedUnavailable && /404|unavailable/.test(message)) {
        // This relay's auth service predates the feed. Not an error the
        // operator can act on by waiting — say so once, then stop polling.
        loggedUnavailable = true;
        console.error(
          `[body] GitHub events: feed unavailable for Room ${deps.roomId}; stopping (${message})`,
        );
        return;
      }
      await sleep(jitter(backoffMs), deps.signal);
      backoffMs = Math.min(ERROR_BACKOFF_MAX_MS, backoffMs * 2);
    }
  }
}
