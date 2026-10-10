const listeners = new Set<() => void>();
let generation = 0;

/**
 * Every client copy of account data registers here. An identity or relay
 * change runs each listener once, so no copy outlives the account it was
 * read for. Stores added later hook this instead of watching sign-in alone.
 */
export function subscribeClientReset(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Async work saves this number when it starts and drops its result when the
 * number has changed, because the result belongs to the previous account.
 */
export function clientResetGeneration(): number {
  return generation;
}

export function resetClientState(): void {
  generation += 1;
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // One failing copy must not keep the others on the old account.
    }
  }
}
