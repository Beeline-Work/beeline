/** `9+` past nine, so the badge never widens its 44px slot. */
export function compactNeedsYouCount(count: number): string {
  return count > 9 ? '9+' : String(count);
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
