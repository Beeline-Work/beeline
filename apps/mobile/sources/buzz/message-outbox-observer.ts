import { useSyncExternalStore } from 'react';
import type { MessageOutbox, MessageOutboxRecord } from './message-outbox';
let records: readonly MessageOutboxRecord[] = [];
const listeners = new Set<() => void>();
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
