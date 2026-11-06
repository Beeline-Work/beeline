import type { InstitutionalContextSnapshot } from '@beeline/api-contract/daemon';
import type { DaemonApiClient } from './daemon-api-client.js';

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
 * fetch below failed.
 */
export const INSTITUTIONAL_CONTEXT_MISSED_TEXT =
  'institutional memory did not load this turn; use search(scope:memory) before concluding anything is not stored.';

export type InstitutionalContextOutcome = 'served' | 'empty' | 'timed-out';

export interface InstitutionalContextFetch {
  readonly promise: Promise<InstitutionalContextSnapshot>;
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
  enabled = true,
): InstitutionalContextFetch {
  const promise = enabled
    ? api.execute('getInstitutionalContext', { roomId })
    : Promise.resolve(EMPTY_INSTITUTIONAL_CONTEXT);
  // Deliberately unused: this only marks the promise as handled so an
  // unread miss never surfaces as an unhandled rejection.
  promise.catch(() => {});
  return { promise };
}

/** Wait for the requested snapshot. A rejected read carries an explicit miss
 * into the prompt so unavailable memory never appears to be empty memory. */
export async function awaitInstitutionalContext(
  fetch: InstitutionalContextFetch,
  log: (message: string) => void = console.warn,
): Promise<InstitutionalContextSnapshot & { outcome: InstitutionalContextOutcome }> {
  try {
    const snapshot = await fetch.promise;
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
  }
}
