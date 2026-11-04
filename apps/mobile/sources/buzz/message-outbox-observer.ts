import { useCallback, useSyncExternalStore } from 'react';
import type { MessageOutbox, MessageOutboxRecord } from './message-outbox';
import { outboxRoomId } from './message-outbox';
let records: readonly MessageOutboxRecord[] = [];
const listeners = new Set<() => void>();
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function observeMessageOutbox(owner?: MessageOutbox): () => void {
  const publish = () => {
    records = owner?.snapshot() ?? [];
    for (const listener of listeners) listener();
  };
  publish();
  return owner?.subscribe(publish) ?? (() => undefined);
}
export function useOutboxRecords() {
  return useSyncExternalStore(
    listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => records,
  );
}

/** A Room row paints only its newest unseen refusal, not the delivery queue. */
export function useRoomOutboxFailure(roomId: string) {
  const snapshot = useCallback(() => {
    for (let index = records.length - 1; index >= 0; index--) {
      const record = records[index]!;
      if (outboxRoomId(record) === roomId && record.reason && !record.seen) return record;
    }
    return undefined;
  }, [roomId]);
  return useSyncExternalStore(subscribe, snapshot);
}
