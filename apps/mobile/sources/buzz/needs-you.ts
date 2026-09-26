import { useEffect, useState } from 'react';
import { monolithPhoneOperation } from '@/sync/transport/monolith-operation';

const listeners = new Set<() => void>();

/** A cell was cleared here: every mounted tray badge re-reads its count. */
export function announceNeedsYouChanged(): void {
  for (const listener of listeners) listener();
}

/** `9+` past nine, so the badge never widens its 44px slot. */
export function compactNeedsYouCount(count: number): string {
  return count > 9 ? '9+' : String(count);
}

/**
 * The tray badge: the server's Needs-you count for this Workspace. It is
 * re-read whenever `refreshKey` changes — callers pass their Room-list
 * payload, which already follows live traffic — and after a clear. Reading
 * the count never starts a cell's 24-hour clock; only opening the tray does.
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
    let cancelled = false;
    void (async () => {
      try {
        const result = await monolithPhoneOperation('countNeedsYou', { workspaceId });
        if (!cancelled) setCount(result.count);
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

/** `expires in 6h` inside a cell's last six hours, else nothing. */
export function needsYouExpiryLabel(expiresAt: number | undefined, nowMs: number): string | null {
  if (expiresAt === undefined) return null;
  const remaining = expiresAt - Math.floor(nowMs / 1000);
  if (remaining <= 0 || remaining > EXPIRY_NOTICE_SECONDS) return null;
  return `expires in ${Math.max(1, Math.ceil(remaining / 3600))}h`;
}
