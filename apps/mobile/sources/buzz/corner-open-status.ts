import { useSyncExternalStore } from 'react';

/**
 * The one corner create in flight, or the last one that could not reach the
 * server (corner-open network-failure mock). Every entry point — the Room
 * list and sidebar long-press, the Corners page +, the Room's corner door and
 * forward-to-new-corner — runs through `openRandomNamedCorner`, which writes
 * here; `CornerOpenToast` and the Corners page placeholder row read it.
 */
export type CornerOpenStatus =
  | { status: 'idle' }
  | {
      status: 'pending';
      roomId: string;
      /** Epoch ms the request left the phone; the row counts up from it. */
      startedAt: number;
      /** A second tap landed while this one was in flight. */
      again: boolean;
    }
  | {
      status: 'failed';
      roomId: string;
      /** The server never answered within the request deadline. */
      timedOut: boolean;
      /** Repeats the same attempt, so the server never makes a second corner. */
      retry: () => void;
    };

/**
 * `MONOLITH_REQUEST_TIMEOUT_MS` in seconds, the deadline `createHumanCorner`
 * runs under; restated so this module stays free of the session and its
 * native storage (`room-list-new-corner.test.ts` holds the two equal).
 */
export const CORNER_OPEN_DEADLINE_SECONDS = 15;

let current: CornerOpenStatus = { status: 'idle' };
const listeners = new Set<() => void>();

function set(next: CornerOpenStatus): void {
  current = next;
  for (const listener of listeners) listener();
}

export function cornerOpenStatus(): CornerOpenStatus {
  return current;
}

export function useCornerOpenStatus(): CornerOpenStatus {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    cornerOpenStatus,
    cornerOpenStatus,
  );
}

export function cornerOpenStarted(roomId: string, now = Date.now()): void {
  set({ status: 'pending', roomId, startedAt: now, again: false });
}

export function cornerOpenEnded(): void {
  set({ status: 'idle' });
}

export function cornerOpenUnreachable(roomId: string, timedOut: boolean, retry: () => void): void {
  set({ status: 'failed', roomId, timedOut, retry });
}

/**
 * A tap that the caller's in-flight guard dropped: the pending row says
 * "Still opening…" instead of nothing happening.
 */
export function cornerOpenTappedAgain(): void {
  if (current.status === 'pending') set({ ...current, again: true });
}

/**
 * Rooms whose Corners page is on screen. That page shows a pending create as
 * its own placeholder row, so the toast stays away for those Rooms.
 */
const listedRooms = new Map<string, number>();

export function listCornerOpens(roomId: string): () => void {
  listedRooms.set(roomId, (listedRooms.get(roomId) ?? 0) + 1);
  set({ ...current });
  return () => {
    const count = (listedRooms.get(roomId) ?? 1) - 1;
    if (count) listedRooms.set(roomId, count);
    else listedRooms.delete(roomId);
    set({ ...current });
  };
}

export function cornerOpensListed(roomId: string): boolean {
  return listedRooms.has(roomId);
}

/** Whether `error` means the server never answered (deadline or network). */
export function isCornerOpenUnreachable(error: unknown): { timedOut: boolean } | null {
  // `MonolithRequestTimeoutError` by name, so this module stays free of the
  // session and its native storage (the browser proof bundles it).
  if (error instanceof Error && error.name === 'MonolithRequestTimeoutError')
    return { timedOut: true };
  if (error instanceof TypeError) return { timedOut: false };
  return null;
}
