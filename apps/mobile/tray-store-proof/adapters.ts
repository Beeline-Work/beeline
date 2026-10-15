// Isolated server/disk fixtures; the native proof uses the production store.
export const items = [1, 2].map((id) => ({ messageId: `ask-${id}`, workspaceId: 'ws',
  roomId: `room-${id}`, roomName: id === 1 ? 'Release' : 'Design', roomKind: 'room' as const,
  text: id === 1 ? 'Approve the Android release?' : 'Please review the new welcome copy?',
  createdAt: Math.floor(Date.now() / 1000) }));
export const requests: string[] = [];
export const getEffectiveRelayUrl = async () => 'https://fixture.invalid';
export const loadBuzzIdentity = async () => ({ publicKey: 'fixture-viewer' });
export const surfaceAddress = (_relay: string, _viewer: string, endpoint: string) => endpoint;
export const mobileSurfaceCache = {
  read: async (address: string) => address.endsWith('needs-you') ? { items: [] } : { bookmarks: [] },
  write: async () => undefined,
  remove: async () => undefined,
};
export const sharedLiveConnection = () => ({ register: async () => () => undefined });
export async function monolithPhoneOperation(name: string, input: { markSeen?: boolean; messageIds?: string[] }) {
  requests.push(`${name} ${JSON.stringify(input)}`);
  if (name === 'countNeedsYou') return { count: items.length };
  if (name === 'readNeedsYou') {
    if (input.markSeen !== false) throw new Error('Badge read must not start expiry');
    return { items };
  }
  if (name === 'markNeedsYouSeen') return { seen: input.messageIds!.map(messageId =>
    ({ messageId, expiresAt: Math.floor(Date.now() / 1000) + 86400 })) };
  throw new Error(`Unexpected request: ${name}`);
}
