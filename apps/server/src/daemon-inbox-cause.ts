import type { LiveEvent } from './live.js';

/** Durable helper context is message-owned. Turns, usage, grants, read marks,
 * corner status and another agent's activity never authorize an inbox reread.
 * Command authority has its separate targeted commands projection. */
export function changesDaemonInbox(event: Extract<LiveEvent, { type: 'invalidate' }>): boolean {
  return typeof event.messageId === 'string' && !!event.messageId &&
    (event.reason === 'postgres:messages' || event.reason === 'phone-write');
}
