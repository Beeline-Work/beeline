/**
 * Module-scoped record of which chat Room/corner screen is currently open.
 *
 * The root notification handler runs OUTSIDE the React tree (it is registered
 * once at module scope in `app/_layout.tsx`), so it cannot read route params
 * or component state. This tracker is the lightweight bridge: the chat screen
 * pushes its channel id on mount/param change and releases it on unmount.
 *
 * A stack, not a single slot: Expo Router keeps the underlying Room mounted
 * when a corner chat is pushed on top of it, so releasing the corner must
 * fall back to the Room still visible underneath rather than to nothing.
 * Deliberately synchronous and dependency-free — the notification handler is
 * on a hot path shared with every push delivery.
 */

const openChannelStack: string[] = [];

function removeFromStack(id: string): void {
  const index = openChannelStack.lastIndexOf(id);
  if (index !== -1) {
    openChannelStack.splice(index, 1);
  }
}

/** Called by the chat screen when it becomes the visible conversation. */
export function pushOpenBuzzChannelId(channelId: string | null | undefined): void {
  const trimmed = typeof channelId === 'string' ? channelId.trim() : '';
  if (!trimmed) {
    return;
  }
  removeFromStack(trimmed);
  openChannelStack.push(trimmed);
}

/** Called by the chat screen on unmount / param change away from a channel. */
export function releaseOpenBuzzChannelId(channelId: string | null | undefined): void {
  const trimmed = typeof channelId === 'string' ? channelId.trim() : '';
  if (!trimmed) {
    return;
  }
  removeFromStack(trimmed);
}

/** Top-most open chat channel id, or null when no chat screen is mounted. */
export function getOpenBuzzChannelId(): string | null {
  return openChannelStack.length > 0 ? openChannelStack[openChannelStack.length - 1] : null;
}

/** Test-only reset. */
export function resetOpenBuzzChannelIdsForTests(): void {
  openChannelStack.length = 0;
}
