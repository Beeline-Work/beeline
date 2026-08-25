/**
 * Key-succession chain loading for the mobile app.
 *
 * After a device-key replacement (GitHub-linked recovery), the new key is the
 * SAME Beeline identity as the lost one. The auth service records that
 * succession; this module fetches the predecessor keys so Workspace discovery
 * can find — and migrate into — everything the old key held. Best-effort and
 * session-cached: an unreachable auth service degrades to ordinary discovery,
 * never blocks sign-in.
 */
import { fetchIdentityPredecessors } from '@beeline/buzz-client';
import type { Identity } from '@beeline/buzz-client';

const cache = new Map<string, string[]>();
const SUCCESSION_LOOKUP_TIMEOUT_MS = 5_000;

function withSuccessionTimeout<T>(promise: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('identity succession lookup timed out')),
      SUCCESSION_LOOKUP_TIMEOUT_MS,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Reset the per-session cache (tests / explicit revalidation). */
export function resetSuccessionChainCache(): void {
  cache.clear();
}

/**
 * Predecessor pubkeys for this identity (oldest first), or [] when none are
 * known or the lookup fails. Cached per pubkey for the app session.
 */
export async function loadSuccessionPredecessors(
  relayUrl: string,
  identity: Pick<Identity, 'secretKey' | 'publicKey'>,
): Promise<string[]> {
  const cached = cache.get(identity.publicKey);
  if (cached) return cached;
  try {
    const predecessors = await withSuccessionTimeout(fetchIdentityPredecessors(relayUrl, identity));
    if (predecessors.length > 0) cache.set(identity.publicKey, predecessors);
    return predecessors;
  } catch {
    return [];
  }
}
