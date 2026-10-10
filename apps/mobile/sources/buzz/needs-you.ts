import { useEffect, useState } from 'react';
import { monolithPhoneOperation } from '@/sync/transport/monolith-operation';
import type { NeedsYouItemView } from '@beeline/api-contract/phone';
import { subscribeClientReset } from '@/sync/client-reset';

export type NeedsYouLiveDelta = { readonly workspaceId: string; readonly sourceRoomId: string;
  readonly count: number; readonly items: readonly NeedsYouItemView[] };
const liveCounts = new Map<string, number>();
const liveVersions = new Map<string, number>();
const liveListeners = new Set<(delta: NeedsYouLiveDelta) => void>();

export function applyNeedsYouLiveDelta(delta: NeedsYouLiveDelta): void {
  liveCounts.set(delta.workspaceId, delta.count);
  liveVersions.set(delta.workspaceId, (liveVersions.get(delta.workspaceId) ?? 0) + 1);
  for (const listener of liveListeners) listener(delta);
}

export function subscribeNeedsYouLiveDelta(
  listener: (delta: NeedsYouLiveDelta) => void,
): () => void {
  liveListeners.add(listener);
  return () => { liveListeners.delete(listener); };
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

subscribeClientReset(() => {
  liveCounts.clear();
  liveVersions.clear();
  countsInFlight.clear();
});

/**
 * The tray badge follows exact live counts. A covering Room-list read supplies
 * its count after an unproven socket gap. Reading a count never starts a cell's
 * 24-hour clock; only opening the tray does.
 */
export function useNeedsYouCount(workspaceId: string | null | undefined, refreshKey: unknown) {
  const [count, setCount] = useState(() => workspaceId ? liveCounts.get(workspaceId) ?? 0 : 0);
  useEffect(() => {
    setCount(workspaceId ? liveCounts.get(workspaceId) ?? 0 : 0);
    const stop = subscribeNeedsYouLiveDelta((delta) => {
      if (delta.workspaceId === workspaceId) setCount(delta.count);
    });
    return stop;
  }, [workspaceId]);
  useEffect(() => {
    if (!workspaceId) {
      setCount(0);
      return;
    }
    // A caller with nothing read yet has nothing to count against.
    if (refreshKey === undefined) return;
    let cancelled = false;
    const version = liveVersions.get(workspaceId) ?? 0;
    void (async () => {
      try {
        const next = await countNeedsYou(workspaceId);
        if (!cancelled && version === (liveVersions.get(workspaceId) ?? 0)) {
          liveCounts.set(workspaceId, next);
          setCount(next);
        }
      } catch {
        // A failed count keeps the last one: the tray itself is the truth.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceId, refreshKey]);
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
