/**
 * Compact relative age for an index row (the Room list, the DM list).
 *
 * Rendered in mono next to a room name, so it has to stay narrow and stable
 * in width: one letter of unit, and the value steps to the next unit before it
 * ever needs three digits. Truncating rather than rounding is deliberate —
 * rounding lets 3599s render as "60m", which reads as a broken clock.
 *
 * A timestamp slightly in the future is normal, not an error: the writer and
 * the reader are independent clocks (the same reasoning as
 * `isAgentPresenceOnline`'s two-sided freshness check). It reads as "now".
 */
const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const YEAR = 365 * DAY;

export function compactRelativeTime(seconds: number | undefined, nowMs: number): string {
  if (!seconds || seconds <= 0) return '';
  const elapsed = Math.floor(nowMs / 1000) - Math.floor(seconds);
  if (elapsed < 45) return 'now';
  if (elapsed < HOUR) return `${Math.max(1, Math.floor(elapsed / MINUTE))}m`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}h`;
  if (elapsed < WEEK) return `${Math.floor(elapsed / DAY)}d`;
  if (elapsed < YEAR) return `${Math.floor(elapsed / WEEK)}w`;
  return `${Math.floor(elapsed / YEAR)}y`;
}
