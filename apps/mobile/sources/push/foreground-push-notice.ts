import { useSyncExternalStore } from 'react';

import type { ForegroundInAppNotice } from './foreground-policy';

let current: ForegroundInAppNotice | null = null;
let openHandler: ((notice: ForegroundInAppNotice) => void) | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

export function foregroundPushNotice(): ForegroundInAppNotice | null {
  return current;
}

export function useForegroundPushNotice(): ForegroundInAppNotice | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    foregroundPushNotice,
    foregroundPushNotice,
  );
}

/** Show one in-app notice; a later push replaces it. */
export function presentForegroundPushNotice(notice: ForegroundInAppNotice): void {
  current = notice;
  notify();
}

/** The root layout registers the navigator tap. Returns an unregister. */
export function setForegroundPushOpenHandler(
  handler: (notice: ForegroundInAppNotice) => void,
): () => void {
  openHandler = handler;
  return () => {
    if (openHandler === handler) openHandler = null;
  };
}

/** Open the noticed Room through the mounted navigator and dismiss the plate. */
export function tapForegroundPushNotice(): void {
  const notice = current;
  current = null;
  notify();
  if (notice) openHandler?.(notice);
}

export function dismissForegroundPushNotice(): void {
  if (!current) return;
  current = null;
  notify();
}

/** Test-only reset. */
export function resetForegroundPushNoticeForTests(): void {
  current = null;
  openHandler = null;
  notify();
}
