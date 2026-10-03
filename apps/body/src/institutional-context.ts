import { performance } from 'node:perf_hooks';
import type { InstitutionalContextSnapshot } from '@beeline/api-contract/daemon';
import type { DaemonApiClient } from './daemon-api-client.js';

/**
 * Raised alongside `INSTITUTIONAL_CONTEXT_EMBEDDING_TIMEOUT_MS` (400ms,
 * packages/api-contract/src/institutional-memory.ts): this whole-snapshot
 * budget must stay above that slice plus room for the DB queries the
 * snapshot runs after it, or the embedding call would never get to spend its
 * own full deadline before this race cuts the whole RPC off first.
 */
export const INSTITUTIONAL_CONTEXT_TIMEOUT_MS = 500;
export const INSTITUTIONAL_MEMORY_LIVE_FLAG = 'BEELINE_INSTITUTIONAL_MEMORY_ENABLED';

/** Institutional memory is ON by default: the flag is an OFF switch, so only an
 *  explicit `false` disables it. */
export function institutionalMemoryFlagEnabled(
  env: NodeJS.ProcessEnv,
  flag: string,
): boolean {
  return env[flag] !== 'false';
}

export const EMPTY_INSTITUTIONAL_CONTEXT: InstitutionalContextSnapshot = {
  snapshotRevision: 0,
  text: '',
  itemIds: [],
  totalBytes: 0,
  omitted: {},
};

/**
 * A miss must never read like "nothing relevant was ever saved" — that is
 * exactly the silence that let an agent trust a broken `search_memory` result
 * over the truth. This line is what the prompt carries instead whenever the
 * fetch below did not finish in time.
 */
export const INSTITUTIONAL_CONTEXT_MISSED_TEXT =
  'institutional memory did not load this turn; use search_memory before concluding anything is not stored.';

export type InstitutionalContextOutcome = 'served' | 'empty' | 'timed-out';

export interface InstitutionalContextFetch {
  readonly promise: Promise<InstitutionalContextSnapshot>;
  /** This process's monotonic clock, matching `awaitInstitutionalContext`'s. */
  readonly startedAt: number;
}

/**
 * Kick the snapshot request off as early as a turn can — before, not after,
 * harness activation — so its own network round trip has somewhere to hide:
 * activation alone routinely takes longer than the round trip does. Never
 * await the returned promise directly; hand the whole handle to
 * `awaitInstitutionalContext` at the point the prompt actually needs the
 * result. The promise is given an immediate no-op catch here so a turn that
 * is cancelled or superseded before reading the result never produces an
 * unhandled rejection — the real error is still observed by whoever does
 * await it.
 */
export function startInstitutionalContextFetch(
  api: Pick<DaemonApiClient, 'execute'>,
  roomId: string,
  enabled = institutionalMemoryFlagEnabled(process.env, INSTITUTIONAL_MEMORY_LIVE_FLAG),
  now: () => number = () => performance.now(),
): InstitutionalContextFetch {
  const startedAt = now();
  const promise = enabled
    ? api.execute('getInstitutionalContext', { roomId })
    : Promise.resolve(EMPTY_INSTITUTIONAL_CONTEXT);
  // Deliberately unused: this only marks the promise as handled so an
  // unread miss never surfaces as an unhandled rejection.
  promise.catch(() => {});
  return { promise, startedAt };
}

/**
 * Memory is an optional context lane. It can never delay or fail the turn:
 * this waits only for whatever budget the fetch has not already spent since
 * it started — activation usually spends all of it for free — then takes
 * whatever the fetch produced. A genuine miss is never silent: the returned
 * snapshot's `text` says so explicitly, and `outcome` distinguishes a served
 * snapshot, a legitimately empty one (nothing matched), and a timed-out one,
 * for the turn trace.
 */
export async function awaitInstitutionalContext(
  fetch: InstitutionalContextFetch,
  log: (message: string) => void = console.warn,
  budgetMs = INSTITUTIONAL_CONTEXT_TIMEOUT_MS,
  now: () => number = () => performance.now(),
): Promise<InstitutionalContextSnapshot & { outcome: InstitutionalContextOutcome }> {
  const remainingMs = budgetMs - (now() - fetch.startedAt);
  let timer: NodeJS.Timeout | undefined;
  try {
    const snapshot = await Promise.race([
      fetch.promise,
      new Promise<InstitutionalContextSnapshot>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('institutional context timed out')),
          Math.max(0, remainingMs),
        );
        timer.unref?.();
      }),
    ]);
    return { ...snapshot, outcome: snapshot.text !== '' ? 'served' : 'empty' };
  } catch (error) {
    log(
      `institutional context unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
    return {
      ...EMPTY_INSTITUTIONAL_CONTEXT,
      text: INSTITUTIONAL_CONTEXT_MISSED_TEXT,
      outcome: 'timed-out',
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
