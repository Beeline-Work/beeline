import type { PhoneOperationMap } from '@beeline/api-contract/phone';
import type { LiveWireEvent } from './monolith-rig-transport';

type PhoneLiveEvent = LiveWireEvent | { type: 'operation-completed'; operation: keyof PhoneOperationMap } | { type: 'socket-dropped' } | { type: 'room-released'; roomId: string };
const listeners = new Set<(event: PhoneLiveEvent) => void>();

/** Domain owners observe committed frames and connection lifetime directly. */
export function subscribePhoneLiveEvents(listener: (event: PhoneLiveEvent) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function publishPhoneLiveEvent(event: PhoneLiveEvent): void {
  for (const listener of listeners) {
    try { listener(event); }
    catch (reason) { console.warn('[phone-live] Observer failed', reason instanceof Error ? reason.name : 'unknown'); }
  }
}
