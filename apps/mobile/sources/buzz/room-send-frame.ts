import { useCallback, useMemo, useState } from 'react';
import { mergeDisplayPages, type ChatDisplayMessage } from '@/sync/transport/buzz-event-projection';
import { reconcileOptimisticMessage } from '@/buzz/reconcileOptimisticMessage';

export type RoomSendFrame = {
  /** Stable FlatList data. A Room send must never rebuild this collection. */
  transcript: ChatDisplayMessage[];
  /** Tiny in-memory overlay painted in the inverted list's newest slot. */
  optimistic: ChatDisplayMessage[];
};

/**
 * Prepare the synchronous Room-send paint without touching durable history.
 *
 * The durable surface refresh owns the latest server-resolved Room state. Until that signed
 * event arrives, the unsent row is a one-item in-memory overlay. Keeping the
 * transcript reference intact prevents a composer mutation from walking,
 * deduplicating, or sorting every loaded message before the next frame.
 */
export function projectRoomSendFrame(
  transcript: ChatDisplayMessage[],
  optimisticMessages: readonly ChatDisplayMessage[],
  committedIds: ReadonlySet<string>,
): RoomSendFrame {
  return {
    transcript,
    optimistic: optimisticMessages.filter((message) => !committedIds.has(message.id)),
  };
}

/** Append the normally single in-flight row without invoking a transcript sorter. */
export function appendOptimisticMessages(
  current: readonly ChatDisplayMessage[],
  incoming: readonly ChatDisplayMessage[],
): ChatDisplayMessage[] {
  if (incoming.length === 0) return [...current];
  const incomingIds = new Set(incoming.map((message) => message.id));
  return [
    ...current.filter((message) => !incomingIds.has(message.id)),
    ...incoming.map((message) => ({ ...message, isNew: true })),
  ];
}

/**
 * The React state boundary driven by the Room composer.
 *
 * A hook keeps the regression test on the actual append → state update →
 * projection path without mounting the full chat screen. Corner append keeps
 * its pre-existing sorted merge; only Rooms take the constant-size overlay.
 */
export function useRoomSendFrame(
  transcript: ChatDisplayMessage[],
  committedIds: ReadonlySet<string>,
  isCorner: boolean,
) {
  const [optimisticMessages, setOptimisticMessages] = useState<ChatDisplayMessage[]>([]);
  const frame = useMemo(
    () => projectRoomSendFrame(transcript, optimisticMessages, committedIds),
    [committedIds, optimisticMessages, transcript],
  );
  const append = useCallback(
    (incoming: readonly ChatDisplayMessage[]) => {
      setOptimisticMessages((current) =>
        isCorner
          ? mergeDisplayPages(
              current,
              incoming.map((message) => ({ ...message, isNew: true })),
            )
          : appendOptimisticMessages(current, incoming),
      );
    },
    [isCorner],
  );
  const reconcile = useCallback((optimisticId: string, eventId: string) => {
    setOptimisticMessages((current) => reconcileOptimisticMessage(current, optimisticId, eventId));
  }, []);
  const remove = useCallback((optimisticId: string) => {
    setOptimisticMessages((current) => current.filter((message) => message.id !== optimisticId));
  }, []);
  const clear = useCallback(() => setOptimisticMessages([]), []);

  return { frame, append, reconcile, remove, clear } as const;
}
