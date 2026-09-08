import type { Identity } from '@beeline/buzz-client';
import type { BuzzPushRegistrationResult } from './buzz-push-registration';

interface PushLifecycle {
  loadIdentity(): Promise<Identity | null>;
  subscribeIdentityChange(listener: () => void): () => void;
  subscribeForeground(listener: () => void): () => void;
  register(identity: Identity): Promise<BuzzPushRegistrationResult>;
  retry(identity: Identity): Promise<BuzzPushRegistrationResult | null>;
  reportUpdate(identity: Identity): Promise<unknown>;
  reportFailure(error: unknown): void;
}

/** Start before loading identity so a sign-in during startup cannot be lost.
 * Serialize attempts: an account change during FCM acquisition is followed by
 * registration for the current identity, never a stale mount-time snapshot.
 */
export function startPushRegistrationLifecycle(deps: PushLifecycle): () => void {
  let disposed = false;
  let running = false;
  let pending: 'register' | 'retry' | null = null;
  let registeredIdentity: string | null = null;

  async function drain() {
    if (running || disposed) return;
    running = true;
    try {
      while (pending && !disposed) {
        const mode = pending;
        pending = null;
        try {
          const identity = await deps.loadIdentity();
          if (disposed) return;
          if (!identity) {
            registeredIdentity = null;
            continue;
          }
          void deps.reportUpdate(identity).catch(deps.reportFailure);
          const result =
            mode === 'register' || identity.publicKey !== registeredIdentity
              ? await deps.register(identity)
              : await deps.retry(identity);
          registeredIdentity = identity.publicKey;
          if (result && !result.registered) {
            deps.reportFailure(new Error(`registration not completed: phase=${result.phase}`));
          }
        } catch (error) {
          deps.reportFailure(error);
        }
      }
    } finally {
      running = false;
    }
  }
  function request(mode: 'register' | 'retry') {
    // Identity availability takes priority over a simultaneous foreground retry.
    if (pending !== 'register') pending = mode;
    void drain();
  }
  const stopIdentity = deps.subscribeIdentityChange(() => request('register'));
  const stopForeground = deps.subscribeForeground(() => request('retry'));
  request('register');
  return () => {
    disposed = true;
    stopIdentity();
    stopForeground();
  };
}
