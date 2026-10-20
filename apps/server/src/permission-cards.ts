import type { RoomViewMessage } from '@beeline/api-contract/phone';

/** Fold signed permission history into the single paint-ready card it models. */
export function collapsePermissionCards(projected: readonly RoomViewMessage[]): RoomViewMessage[] {
  const latestPermission = new Map<string, RoomViewMessage>();
  for (const message of projected) {
    if (!message.permission) continue;
    const existing = latestPermission.get(message.permission.permissionId);
    if (!existing?.permission || existing.permission.status === 'pending') {
      latestPermission.set(message.permission.permissionId, message);
    } else if (message.permission.status !== 'pending') {
      latestPermission.set(message.permission.permissionId, message);
    }
  }
  return projected.filter(
    (message) =>
      !message.permission || latestPermission.get(message.permission.permissionId) === message,
  );
}
