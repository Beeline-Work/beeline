// Test-only boundaries: fixture DTOs, an in-memory cache and controlled server replies.
// The production route, session, refresh scheduler, transcript and error UI stay real.
export const fixture = {
  room: {
    id: 'f1a3d389-4adb-4e91-8e3d-d5f2171a84f6',
    workspaceId: 'f0b23d83-96a5-4ca4-9a46-fc8e3c1e82a1',
    name: 'offline-notice-proof',
    archived: false,
    createdAt: 1,
    updatedAt: 2,
  },
  messages: [
    {
      id: '3333333333333333333333333333333333333333333333333333333333333333',
      text: 'The saved conversation is still here.',
      createdAt: 1720000000,
      author: {
        pubkey: '2222222222222222222222222222222222222222222222222222222222222222',
        kind: 'human',
        name: 'Casey',
        handle: 'casey',
      },
      presentation: 'message',
    },
  ],
  members: [
    {
      identity: {
        pubkey: '1111111111111111111111111111111111111111111111111111111111111111',
        kind: 'human',
        name: 'Reader',
        handle: 'reader',
      },
      role: 'member',
    },
    {
      identity: {
        pubkey: '2222222222222222222222222222222222222222222222222222222222222222',
        kind: 'human',
        name: 'Casey',
        handle: 'casey',
      },
      role: 'member',
    },
  ],
  latestAgentTurns: [],
  viewer: {
    identity: {
      pubkey: '1111111111111111111111111111111111111111111111111111111111111111',
      kind: 'human',
      name: 'Reader',
    },
    role: 'member',
    permissions: { send: false, manage: false },
  },
  repositoryResolution: 'none',
  watchFilters: [{ '#h': ['f1a3d389-4adb-4e91-8e3d-d5f2171a84f6'] }],
};
export const controls = { cached: true, response: 'pending', requests: [], reads: 0 };
export function resetProof(cached = true) {
  controls.cached = cached;
  controls.response = cached ? 'pending' : 'failed';
  controls.requests = [];
  controls.reads = 0;
}
export function failRefresh() {
  controls.response = 'failed';
  controls.requests
    .splice(0)
    .forEach(({ reject }) => reject(new TypeError('Network request failed')));
}
export function recoverServer() {
  controls.response = 'success';
}
const noop = () => {};
const asyncNoop = async () => {};
export const peekBuzzViewerContext = () => null;
export const loadBuzzIdentity = async () => ({
  publicKey: '1111111111111111111111111111111111111111111111111111111111111111',
  secretKey: new Uint8Array(32),
});
export const loadBuzzViewerPubkey = async () =>
  '1111111111111111111111111111111111111111111111111111111111111111';
export const getEffectiveRelayUrl = async () => 'https://offline-proof.invalid';
export const loadActiveCommunityId = async () => 'f0b23d83-96a5-4ca4-9a46-fc8e3c1e82a1';
export const saveActiveCommunityId = asyncNoop;
export const saveLastViewedChannel = asyncNoop;
export const mobileSurfaceCache = {
  read: async (address) =>
    controls.cached && address.path === '/room/f1a3d389-4adb-4e91-8e3d-d5f2171a84f6'
      ? fixture
      : null,
  fetch: async (_address, _validate, load) => load(),
  peek: () => null,
  observe: () => noop,
  subscribe: () => noop,
  write: asyncNoop,
  remove: asyncNoop,
  persist: asyncNoop,
  clear: noop,
};
export const surfaceAddress = (relayOrigin, viewerPubkey, path, params) => ({
  relayOrigin,
  viewerPubkey,
  path,
  params,
});
export const createRoomOutbox = () => ({
  subscribe: () => noop,
  state: () => undefined,
  acknowledgeFailures: asyncNoop,
  restore: asyncNoop,
  list: () => [],
  reconcile: asyncNoop,
  get: noop,
  fail: asyncNoop,
  remove: asyncNoop,
});
const client = {
  surfaceSubscribe: async (_filters, receive) => {
    receive({ monolithLive: { type: 'subscribed', roomId: fixture.room.id } });
    return noop;
  },
};
export class BuzzRigTransport {
  ensureClient = async () => client;
  reconnectLive = noop;
  reopenChat = asyncNoop;
}
export class RoomViewClient {
  room = async () => {
    controls.reads++;
    if (controls.response === 'failed') throw new TypeError('Network request failed');
    if (controls.response === 'success') return fixture;
    return new Promise((resolve, reject) => controls.requests.push({ resolve, reject }));
  };
  markRead = asyncNoop;
  workspace = async () => ({
    workspace: { id: 'f0b23d83-96a5-4ca4-9a46-fc8e3c1e82a1', name: 'Proof' },
    members: fixture.members,
    agents: [],
  });
  corners = async () => ({ room: fixture.room, corners: [], hasMore: false, watchFilters: [] });
  history = async () => ({ messages: [], hasMore: false });
}
export { RoomViewHttpError } from '@beeline/buzz-client';
export const isRoomViewTimeoutError = () => false;
const live = {
  view: () => noop,
  register: async () => noop,
  subscribe: () => noop,
  connectionStatus: () => 'connected',
  subscribeConnectionStatus: () => noop,
  reconnectNow: noop,
};
export const sharedLiveConnection = () => live;
export const useConnectionState = () => 'connected';
export const reconnectNow = noop;
export const liveChatList = () => null;
export const useChatList = () => null;
export const refreshChatList = noop;
export const useVoiceCall = () => ({
  call: null,
  active: false,
  connecting: false,
  error: null,
  agents: [],
  humans: 1,
  level: 0,
  start: asyncNoop,
  stop: asyncNoop,
});
export const monolithPhoneOperation = async (operation) => {
  if (operation === 'readStarPrompt') return { prompt: null };
  throw new Error(`Unexpected proof operation: ${operation}`);
};
export const phoneOperationFailureReason = String;
export const readGitHubAccess = () => null;
export const useGitHubAccess = () => null;
export const updateGitHubAccess = noop;
export const writeGitHubAccess = noop;
export const githubInstallationRedirectUri = () => 'beeline://proof';
export const useGitHubInstallationSession = () => ({
  handleAddGitHubAccount: noop,
  handleManageGitHubInstallation: noop,
});
export const getBuzzRuntimeConfig = () => ({
  monolithUrl: 'https://offline-proof.invalid',
  relayUrl: 'https://offline-proof.invalid',
});

export const Modal = { alert: () => {}, confirm: async () => false, prompt: async () => null };
