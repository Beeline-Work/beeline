import { messageJumpHref } from './corner-navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { RoomViewHttpError } from '@beeline/buzz-client';
import {
  MESSAGE_SEARCH_MIN_CHARS,
  messageSearchTerms,
  type MessageSearchResult,
  type MessageSearchView,
} from '@beeline/api-contract/phone';

/** How long typing has to pause before the Room list asks the server. */
export const MESSAGE_SEARCH_DEBOUNCE_MS = 250;

export type MessageSearchRead = (
  workspaceId: string,
  query: string,
  before?: string,
  signal?: AbortSignal,
) => Promise<MessageSearchView | null>;

/** Why a search read failed: too many matches to finish, too many searches, or anything else. */
export type MessageSearchFailure = 'too_broad' | 'rate_limited' | 'error';

export type MessageSearchState = {
  /**
   * `unavailable`: no query, or a server without message search. `short`: the
   * query has fewer than MESSAGE_SEARCH_MIN_CHARS characters. `filler`: it
   * holds only common words or a word still too short to search.
   */
  readonly status: 'unavailable' | 'short' | 'filler' | 'loading' | 'ready' | MessageSearchFailure;
  /** The trimmed query the status describes. */
  readonly query: string;
  readonly results: readonly MessageSearchResult[];
  readonly hasMore: boolean;
  readonly loadingMore: boolean;
  readonly moreFailed: MessageSearchFailure | null;
  readonly retry: () => void;
  readonly loadMore: () => void;
};

type Page = {
  readonly key: string;
  readonly status: MessageSearchState['status'];
  readonly results: readonly MessageSearchResult[];
  readonly nextBefore?: string;
  readonly loadingMore: boolean;
  readonly moreFailed: MessageSearchFailure | null;
};

const IDLE: Page = { key: '', status: 'unavailable', results: [], loadingMore: false, moreFailed: null };

function failure(error: unknown): MessageSearchFailure {
  if (error instanceof RoomViewHttpError) {
    if (error.status === 429) return 'rate_limited';
    if (error.code === 'query_too_broad') return 'too_broad';
  }
  return 'error';
}

/**
 * The Room list's message search for the typed `query`. It asks only once the
 * query has MESSAGE_SEARCH_MIN_CHARS characters and a searchable word, and
 * asks again only when the searched words change. Changing the query cancels
 * the read in flight, so results always belong to the field.
 */
export function useMessageSearch(
  read: MessageSearchRead | null,
  workspaceId: string | null,
  query: string,
): MessageSearchState {
  const term = query.trim();
  const terms = term.length >= MESSAGE_SEARCH_MIN_CHARS ? messageSearchTerms(term) : null;
  const searchable = Boolean(read && workspaceId);
  const key = searchable && terms ? `${workspaceId}\n${terms}` : '';
  const keyRef = useRef(key);
  keyRef.current = key;
  // Typing that leaves the searched words alone must not ask again.
  const termRef = useRef(term);
  termRef.current = term;
  // A caller's inline read function must not restart the search on every render.
  const readRef = useRef(read);
  readRef.current = read;
  const moreRef = useRef<AbortController | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [page, setPage] = useState<Page>(IDLE);

  useEffect(() => {
    const search = readRef.current;
    if (!key || !search || !workspaceId) {
      setPage(IDLE);
      return;
    }
    setPage({ ...IDLE, key, status: 'loading' });
    const controller = new AbortController();
    const timer = setTimeout(() => {
      search(workspaceId, termRef.current, undefined, controller.signal).then(
        (view) => {
          if (controller.signal.aborted) return;
          setPage(
            view
              ? { ...IDLE, key, status: 'ready', results: view.results, nextBefore: view.nextBefore }
              : { ...IDLE, key },
          );
        },
        (error: unknown) => {
          if (!controller.signal.aborted) setPage({ ...IDLE, key, status: failure(error) });
        },
      );
    }, MESSAGE_SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
      moreRef.current?.abort();
      moreRef.current = null;
    };
  }, [attempt, key, workspaceId]);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  const loadMore = useCallback(() => {
    const search = readRef.current;
    if (!search || !workspaceId || page.key !== key || !page.nextBefore || page.loadingMore) return;
    const before = page.nextBefore;
    const controller = new AbortController();
    moreRef.current = controller;
    setPage((current) => ({ ...current, loadingMore: true, moreFailed: null }));
    search(workspaceId, term, before, controller.signal).then(
      (view) => {
        if (controller.signal.aborted) return;
        setPage((current) =>
          current.key === key && current.nextBefore === before
            ? {
                ...current,
                results: [...current.results, ...(view?.results ?? [])],
                nextBefore: view?.nextBefore,
                loadingMore: false,
              }
            : current,
        );
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        setPage((current) =>
          current.key === key ? { ...current, loadingMore: false, moreFailed: failure(error) } : current,
        );
      },
    );
  }, [key, page, term, workspaceId]);

  const hint: Page | null =
    !searchable || key || !term
      ? null
      : { ...IDLE, status: term.length < MESSAGE_SEARCH_MIN_CHARS ? 'short' : 'filler' };
  const current =
    hint ?? (page.key === key ? page : key ? { ...IDLE, status: 'loading' as const } : IDLE);
  return {
    status: current.status,
    query: term,
    results: current.results,
    hasMore: Boolean(current.nextBefore),
    loadingMore: current.loadingMore,
    moreFailed: current.moreFailed,
    retry,
    loadMore,
  };
}

let messageSearchJump = 0;

/**
 * The Room route for a search result. It rides the same landing a bookmark
 * uses: the transcript pages older history in until the message arrives, then
 * centers and flashes it. Each tap gets its own response id so tapping the
 * same result again lands again.
 */
export function messageSearchHref(result: MessageSearchResult, workspaceId: string) {
  messageSearchJump += 1;
  return messageJumpHref(result.roomId, result.messageId, `message-search:${messageSearchJump}:${result.messageId}`, workspaceId);
}
