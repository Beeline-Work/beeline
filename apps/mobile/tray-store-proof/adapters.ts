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
export async function monolithPhoneOperation(name: string) {
  requests.push(name);
  if (name === 'countNeedsYou') return { count: items.length };
  if (name === 'readNeedsYou') return { items };
  throw new Error(`Unexpected request: ${name}`);
}
