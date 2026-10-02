import { useCallback, useEffect, useRef, useState } from 'react';
import type { MessageSearchResult, MessageSearchView } from '@beeline/api-contract/phone';

/** Shorter queries match too much to be worth a server read. */
export const MESSAGE_SEARCH_MIN_CHARS = 2;
/** How long typing has to pause before the Room list asks the server. */
export const MESSAGE_SEARCH_DEBOUNCE_MS = 250;

export type MessageSearchRead = (
  workspaceId: string,
  query: string,
  before?: string,
) => Promise<MessageSearchView | null>;

export type MessageSearchState = {
  /** `unavailable`: no query long enough, or a server without message search. */
  readonly status: 'unavailable' | 'loading' | 'ready' | 'error';
  readonly results: readonly MessageSearchResult[];
  readonly hasMore: boolean;
  readonly loadingMore: boolean;
  readonly moreFailed: boolean;
  readonly retry: () => void;
  readonly loadMore: () => void;
};

type Page = {
  readonly key: string;
  readonly status: MessageSearchState['status'];
  readonly results: readonly MessageSearchResult[];
  readonly nextBefore?: string;
  readonly loadingMore: boolean;
  readonly moreFailed: boolean;
};

const IDLE: Page = { key: '', status: 'unavailable', results: [], loadingMore: false, moreFailed: false };

/**
 * The Room list's message search for the typed `query`. A response for a query
 * that has since changed is dropped, so results always belong to the field.
 */
export function useMessageSearch(
  read: MessageSearchRead | null,
  workspaceId: string | null,
  query: string,
): MessageSearchState {
  const term = query.trim();
  const key = read && workspaceId && term.length >= MESSAGE_SEARCH_MIN_CHARS ? `${workspaceId}\n${term}` : '';
  const keyRef = useRef(key);
  keyRef.current = key;
  // A caller's inline read function must not restart the search on every render.
  const readRef = useRef(read);
  readRef.current = read;
  const [attempt, setAttempt] = useState(0);
  const [page, setPage] = useState<Page>(IDLE);

  useEffect(() => {
    const search = readRef.current;
    if (!key || !search || !workspaceId) {
      setPage(IDLE);
      return;
    }
    setPage({ ...IDLE, key, status: 'loading' });
    const timer = setTimeout(() => {
      search(workspaceId, term).then(
        (view) => {
          if (keyRef.current !== key) return;
          setPage(
            view
              ? { ...IDLE, key, status: 'ready', results: view.results, nextBefore: view.nextBefore }
              : { ...IDLE, key },
          );
        },
        () => {
          if (keyRef.current === key) setPage({ ...IDLE, key, status: 'error' });
        },
      );
    }, MESSAGE_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [attempt, key, term, workspaceId]);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  const loadMore = useCallback(() => {
    const search = readRef.current;
    if (!search || !workspaceId || page.key !== key || !page.nextBefore || page.loadingMore) return;
    const before = page.nextBefore;
    setPage((current) => ({ ...current, loadingMore: true, moreFailed: false }));
    search(workspaceId, term, before).then(
      (view) => {
        if (keyRef.current !== key) return;
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
      () => {
        if (keyRef.current !== key) return;
        setPage((current) => (current.key === key ? { ...current, loadingMore: false, moreFailed: true } : current));
      },
    );
  }, [key, page, term, workspaceId]);

  const current = page.key === key ? page : key ? { ...IDLE, status: 'loading' as const } : IDLE;
  return {
    status: current.status,
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
  return {
    pathname: '/beeline/chat/[channelId]' as const,
    params: {
      channelId: result.roomId,
      communityId: workspaceId,
      notificationResponseId: `message-search:${messageSearchJump}:${result.messageId}`,
      notificationMessageId: result.messageId,
    },
  };
}
