import { createContext } from 'react';

/**
 * A tapped push waits for the local account/launch-URL decision, so a late
 * onboarding or invite redirect cannot overwrite its destination. The saved
 * deck itself is already the initial route and never replaces itself.
 * Resolution is once per process; later taps and Back do not wait again.
 */

/**
 * Bound on the wait. The landing decision reads secure storage and, on a
 * monolith build, the session. Each wait reports a timeout; the push handler
 * retains the target while local account restoration finishes.
 */
export const INITIAL_LANDING_TIMEOUT_MS = 8000;

let resolved = false;
let suppressed = false;
let waiters: Array<(result: InitialLandingResult) => void> = [];

export type InitialLandingResult = 'committed' | 'timeout';

/** Called after Expo Router reports the landing destination as committed. */
export function markInitialLandingResolved(): void {
  if (resolved) return;
  resolved = true;
  const pending = waiters;
  waiters = [];
  for (const wake of pending) wake('committed');
}

export function isInitialLandingResolved(): boolean {
  return resolved;
}

/**
 * A tapped push with a routable destination has claimed the navigation —
 * including the timeout path, where the landing replace is still pending.
 * The app root must then not run its landing replace at all: it would
 * overwrite the notification navigation (the push opens its Room and is
 * thrown straight back to the deck).
 */
export function suppressInitialLandingNavigation(): void {
  suppressed = true;
  markInitialLandingResolved();
}

export function isInitialLandingNavigationSuppressed(): boolean {
  return suppressed;
}

/** Resolves once the landing route has committed, or on timeout. */
export function whenInitialLandingResolved(
  timeoutMs: number = INITIAL_LANDING_TIMEOUT_MS,
): Promise<InitialLandingResult> {
  if (resolved) return Promise.resolve('committed');
  return new Promise<InitialLandingResult>((resolve) => {
    let done = false;
    const finish = (result: InitialLandingResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => finish('timeout'), timeoutMs);
    waiters.push(finish);
  });
}

/** Test-only reset. */
export function resetInitialLandingForTests(): void {
  resolved = false;
  suppressed = false;
  waiters = [];
}

/** A layout notification, not a prerequisite for painting or routing. */
export const FirstContentDrawContext = createContext<() => void>(() => {});

/** Let the native layout draw before starting nonvisual work. */
export function afterFirstFrame(run: () => void): () => void {
  let secondFrame: number | undefined;
  const firstFrame = requestAnimationFrame(() => {
    secondFrame = requestAnimationFrame(run);
  });
  return () => {
    cancelAnimationFrame(firstFrame);
    if (secondFrame !== undefined) cancelAnimationFrame(secondFrame);
  };
}
