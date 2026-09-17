export type BookmarkChange = { workspaceId: string; bookmarked: boolean };

const listeners = new Set<(change: BookmarkChange) => void>();

export function publishBookmarkChange(change: BookmarkChange): void {
  for (const listener of listeners) listener(change);
}

export function subscribeBookmarkChanges(listener: (change: BookmarkChange) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
