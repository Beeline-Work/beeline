/**
 * The one gate between the app's own first-route decision and a tapped push.
 *
 * `(app)/index.tsx` owns the landing route, and it picks it asynchronously:
 * it reads the stored identity and any initial invite, then `replace`s to the
 * Room deck, onboarding, or a join screen. A notification response that
 * navigates before that decision lands is overwritten by it — the tapped push
 * opens its Room and is thrown straight back to the deck.
 *
 * So the response waits for the landing instead of racing it. The landing is
 * resolved once per process, so a tap on an app that is already running never
 * waits: the promise is already settled.
 */

/**
 * Bound on the wait. The landing decision reads secure storage and, on a
 * monolith build, the session; if it never lands the app is unusable anyway,
 * but a tapped push must never be swallowed by that, so the wait ends.
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
