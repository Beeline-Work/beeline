/**
 * Delivery discipline for lifecycle-critical relay publications.
 *
 * A merge-ready card, an approval acknowledgement, or a land status card is
 * not chatter: when its single publish attempt dies inside a transient relay
 * outage (the recurring 502 windows while the deploy bounced relay-front),
 * the human-facing state machine on the other side never resolves — the
 * owner watched 'APPROVAL SENT · DELIVERING…' spin forever because the
 * merge-ready publication had been dropped and nothing ever retried it.
 *
 * `publishEvent` already retries transport failures and 5xx internally, but
 * only a handful of quick attempts over ~2s — far shorter than one deploy
 * bounce. This module wraps such publishes with a LONGER bounded backoff
 * loop (still bounded: a corner must be able to announce failure rather
 * than hang) and classifies which refusals are worth retrying at all:
 *
 *   - transient  → network/timeout exhaustion, HTTP 5xx, 408, 429
 *   - permanent  → any other 4xx (a signed event refused as invalid will be
 *                  refused identically forever), relay negative-ack
 *
 * Callers treat `false` as "say so plainly": post the honest failure card
 * through this same wrapper (best effort) and leave durable state in the
 * shape where a later poll naturally re-attempts.
 */

import { RelayPublishError } from '@beeline/buzz-client';

/** Total attempts of the OUTER loop (each attempt itself runs publishEvent's
 *  own inner retry budget for transport/5xx). */
export const CRITICAL_PUBLISH_MAX_ATTEMPTS = 6;

/** Base delay for the outer exponential backoff, before jitter. */
export const CRITICAL_PUBLISH_BASE_DELAY_MS = 2_000;

/** Upper bound for one outer backoff step. */
export const CRITICAL_PUBLISH_MAX_DELAY_MS = 30_000;

export function isTransientRelayPublishError(error: unknown): boolean {
  if (error instanceof RelayPublishError) return error.retryable;
  const message = errorText(error);
  // Not a relay-publish failure at all (git failed, logic threw): the caller
  // decides; retrying cannot fix a broken worktree.
  if (!message.includes('publishEvent')) return false;
  const status = /HTTP (\d{3})/.exec(message)?.[1];
  if (status !== undefined) {
    const code = Number(status);
    return code >= 500 || code === 408 || code === 429;
  }
  // No HTTP status: either the internal retry budget was exhausted on
  // transport failures, or the relay negatively acknowledged. Only the
  // former is transient.
  if (message.includes('was not accepted')) return false;
  return true;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : JSON.stringify(error);
}

function delayWithJitter(attempt: number): number {
  const exponential = Math.min(
    CRITICAL_PUBLISH_BASE_DELAY_MS * 2 ** (attempt - 1),
    CRITICAL_PUBLISH_MAX_DELAY_MS,
  );
  // ±25%, matching the daemon's other retry schedules: one daemon publishes
  // several lifecycle events per land, and they were all rejected by the
  // same burst.
  const spread = exponential * 0.25;
  return Math.max(250, Math.round(exponential - spread + Math.random() * spread * 2));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `publish` until it resolves, the attempt budget is spent, or a
 * permanent refusal arrives. Returns true only when the last call resolved.
 * Never throws — a critical publication that ultimately fails is the
 * caller's signal to announce plainly, not to crash the poll that must keep
 * serving every corner behind this one.
 */
export async function publishCritical(
  publish: () => Promise<void>,
  options: {
    label: string;
    maxAttempts?: number;
    onRetry?: (attempt: number, delayMs: number, error: unknown) => void;
    onGiveUp?: (error: unknown) => void;
  },
): Promise<boolean> {
  const maxAttempts = options.maxAttempts ?? CRITICAL_PUBLISH_MAX_ATTEMPTS;
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await publish();
      return true;
    } catch (error) {
      lastError = error;
      if (!isTransientRelayPublishError(error)) {
        options.onGiveUp?.(error);
        return false;
      }
      if (attempt === maxAttempts) break;
      const delayMs = delayWithJitter(attempt);
      options.onRetry?.(attempt, delayMs, error);
      await sleep(delayMs);
    }
  }
  options.onGiveUp?.(lastError);
  return false;
}
