const listeners = new Set<() => void>();

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

export function resetClientState(): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // One failing copy must not keep the others on the old account.
    }
  }
}
