import { useSyncExternalStore } from 'react';

// Presentation only; durable Room state remains server-owned.
let snapshot = { availableWidth: 0, paneOpen: false, showRoomList: true };
const listeners = new Set<() => void>();
function update(next: Partial<typeof snapshot>) {
  if (
    Object.entries(next).every(([key, value]) => snapshot[key as keyof typeof snapshot] === value)
  )
    return;
  snapshot = { ...snapshot, ...next };
  listeners.forEach((listener) => listener());
}
export function setDesktopAvailableWidth(availableWidth: number) {
  update({ availableWidth });
}
export function setDesktopPaneOpen(paneOpen: boolean) {
  update({ paneOpen, showRoomList: !paneOpen });
}
export function toggleDesktopRoomList() {
  update({ showRoomList: !snapshot.showRoomList });
}
export function useDesktopLayout() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => snapshot,
    () => snapshot,
  );
}
