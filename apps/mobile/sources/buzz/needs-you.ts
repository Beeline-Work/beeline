import { useEffect, useState } from 'react';
import { monolithPhoneOperation } from '@/sync/transport/monolith-operation';

const listeners = new Set<() => void>();

/** A cell was cleared here: every mounted tray badge re-reads its count. */
export function announceNeedsYouChanged(): void {
  for (const listener of listeners) listener();
}

const activityListeners = new Set<() => void>();

/** The Room list heard a message that can need the viewer: an open tray reads again. */
export function announceNeedsYouActivity(): void {
  for (const listener of activityListeners) listener();
}

export function subscribeNeedsYouActivity(listener: () => void): () => void {
  activityListeners.add(listener);
  return () => {
    activityListeners.delete(listener);
  };
}

/** `9+` past nine, so the badge never widens its 44px slot. */
export function compactNeedsYouCount(count: number): string {
  return count > 9 ? '9+' : String(count);
}

/** One count per Workspace in flight, shared by every badge that asks at once. */
const countsInFlight = new Map<string, Promise<number>>();

function countNeedsYou(workspaceId: string): Promise<number> {
  const pending = countsInFlight.get(workspaceId);
  if (pending) return pending;
  const request = monolithPhoneOperation('countNeedsYou', { workspaceId })
    .then((result) => result.count)
    .finally(() => countsInFlight.delete(workspaceId));
  countsInFlight.set(workspaceId, request);
  return request;
}

/**
 * Whether a committed message can change anybody's Needs-you count: one that
 * tags the viewer, or a card or system line (approvals, questions, a corner
 * handing back). Plain prose to someone else and tool rows cannot.
 */
export function messageCanNeedViewer(
  message: { readonly presentation: string; readonly mentionPubkeys?: readonly string[] },
  viewerPubkey: string,
): boolean {
  return (
    message.presentation === 'card' ||
    message.presentation === 'system' ||
    Boolean(message.mentionPubkeys?.includes(viewerPubkey))
  );
}

/**
 * The tray badge: the server's Needs-you count for this Workspace. It is
 * re-read whenever `refreshKey` changes — callers bump it when their Room list
 * is read in full or a message that can need the viewer lands, and pass
 * `undefined` until then — and after a clear. Reading the count never starts a cell's 24-hour clock; only opening
 * the tray does.
 */
export function useNeedsYouCount(workspaceId: string | null | undefined, refreshKey: unknown) {
  const [count, setCount] = useState(0);
  const [cleared, setCleared] = useState(0);
  useEffect(() => {
    const listener = () => setCleared((value) => value + 1);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  useEffect(() => {
    if (!workspaceId) {
      setCount(0);
      return;
    }
    // A caller with nothing read yet has nothing to count against.
    if (refreshKey === undefined) return;
    let cancelled = false;
    void (async () => {
      try {
        const next = await countNeedsYou(workspaceId);
        if (!cancelled) setCount(next);
      } catch {
        // A failed count keeps the last one: the tray itself is the truth.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceId, refreshKey, cleared]);
  return count;
}

/** The countdown shows only in a cell's last six hours; the ordinary case is unadorned. */
const EXPIRY_NOTICE_SECONDS = 6 * 60 * 60;

/** `expires in 6h` (or `20m` in its last hour) inside a cell's last six hours, else nothing. */
export function needsYouExpiryLabel(expiresAt: number | undefined, nowMs: number): string | null {
  if (expiresAt === undefined) return null;
  const remaining = expiresAt - Math.floor(nowMs / 1000);
  if (remaining <= 0 || remaining > EXPIRY_NOTICE_SECONDS) return null;
  if (remaining < 3600) return `expires in ${Math.max(1, Math.ceil(remaining / 60))}m`;
  return `expires in ${Math.ceil(remaining / 3600)}h`;
}
