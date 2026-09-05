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
let waiters: Array<() => void> = [];

/** Called by the app root once it has issued its landing navigation. */
export function markInitialLandingResolved(): void {
  if (resolved) return;
  resolved = true;
  const pending = waiters;
  waiters = [];
  for (const wake of pending) wake();
}

export function isInitialLandingResolved(): boolean {
  return resolved;
}

/** Resolves once the app root has chosen its landing route, or on timeout. */
export function whenInitialLandingResolved(
  timeoutMs: number = INITIAL_LANDING_TIMEOUT_MS,
): Promise<void> {
  if (resolved) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    waiters.push(finish);
  });
}

/** Test-only reset. */
export function resetInitialLandingForTests(): void {
  resolved = false;
  waiters = [];
}
