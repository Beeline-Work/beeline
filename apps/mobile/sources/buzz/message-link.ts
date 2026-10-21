import { messageJumpHref } from './corner-navigation';

/** The name is a readable label; only the global message id selects a target. */
export function messageLinkId(url: string): string | null {
  return /^#beeline\/[^\s/()<>]+\/([0-9a-f]{64})$/.exec(url)?.[1] ?? null;
}

let jumpSequence = 0;

export async function openMessageLink(url: string): Promise<void> {
  const messageId = messageLinkId(url);
  if (!messageId) return;
  const [{ loadBuzzIdentity, getEffectiveRelayUrl }, { RoomViewClient }, { router }] = await Promise.all([
    import('@/auth/buzz-identity-storage'),
    import('@/sync/transport/room-view-client'),
    import('expo-router'),
  ]);
  const identity = await loadBuzzIdentity();
  if (!identity) throw new Error('Message not available');
  const target = await new RoomViewClient({ identity, baseUrl: await getEffectiveRelayUrl() })
    .resolveMessageLink(messageId);
  router.navigate(messageJumpHref(target.roomId, target.messageId, `message-link:${++jumpSequence}`, target.workspaceId));
}
