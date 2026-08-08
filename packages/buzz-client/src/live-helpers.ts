/**
 * Shared helpers for live tests against the real Buzz relay.
 * Soft-skip when the relay is unreachable (fresh clone without stack:up).
 */
import { relayReachable } from './http.js';

export const DEFAULT_BASE_URL = process.env.BUZZY_RELAY_URL ?? 'http://127.0.0.1:3010';
export const DEFAULT_HOST =
  process.env.BUZZY_RELAY_HOST ?? new URL(DEFAULT_BASE_URL).host;

export function uniqueMarker(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export async function isRelayUp(): Promise<boolean> {
  return relayReachable(DEFAULT_BASE_URL, DEFAULT_HOST);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Wait until `pred` is true or throw. */
export async function waitFor(
  pred: () => boolean | Promise<boolean>,
  opts?: { timeoutMs?: number; intervalMs?: number; label?: string },
): Promise<void> {
  const timeoutMs = opts?.timeoutMs ?? 20_000;
  const intervalMs = opts?.intervalMs ?? 100;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await pred()) return;
    await sleep(intervalMs);
  }
  throw new Error(`waitFor timeout (${timeoutMs}ms): ${opts?.label ?? 'condition'}`);
}
