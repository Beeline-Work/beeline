/**
 * Corners deliver through Body's ordered edit-session inbox. They are never
 * held behind the parent Room's availability presentation.
 */
export function isOfflineRoomDelivery(isCorner: boolean, agentOffline: boolean): boolean {
  return !isCorner && agentOffline;
}
