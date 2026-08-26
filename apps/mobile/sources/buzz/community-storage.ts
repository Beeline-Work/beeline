import AsyncStorage from '@react-native-async-storage/async-storage';

const ACTIVE_COMMUNITY_PREFIX = '@beeline/community/active/';
const LAST_CHANNEL_PREFIX = '@beeline/community/last-channel/';
const PERSONAL_COMMUNITY_PREFIX = '@beeline/workspace/personal/';
const STANDALONE_SCOPE = 'standalone';

function activeCommunityKey(pubkey: string): string {
  return `${ACTIVE_COMMUNITY_PREFIX}${pubkey}`;
}

function lastChannelKey(pubkey: string, communityId: string | null): string {
  return `${LAST_CHANNEL_PREFIX}${pubkey}/${communityId ?? STANDALONE_SCOPE}`;
}

export async function loadActiveCommunityId(pubkey: string): Promise<string | null> {
  const stored = await AsyncStorage.getItem(activeCommunityKey(pubkey));
  return stored && stored !== STANDALONE_SCOPE ? stored : null;
}

export async function saveActiveCommunityId(
  pubkey: string,
  communityId: string | null,
): Promise<void> {
  await AsyncStorage.setItem(activeCommunityKey(pubkey), communityId ?? STANDALONE_SCOPE);
}

export async function loadPersonalCommunityId(pubkey: string): Promise<string | null> {
  return AsyncStorage.getItem(`${PERSONAL_COMMUNITY_PREFIX}${pubkey}`);
}

export async function savePersonalCommunityId(pubkey: string, communityId: string): Promise<void> {
  await AsyncStorage.setItem(`${PERSONAL_COMMUNITY_PREFIX}${pubkey}`, communityId);
}

export async function clearPersonalCommunityId(pubkey: string): Promise<void> {
  await AsyncStorage.removeItem(`${PERSONAL_COMMUNITY_PREFIX}${pubkey}`);
}

export type WorkspaceSelectionStorage = {
  loadPersonalId: (pubkey: string) => Promise<string | null>;
  saveActiveId: (pubkey: string, workspaceId: string | null) => Promise<void>;
  clearPersonalId: (pubkey: string) => Promise<void>;
};

/**
 * Persist the selection produced by the single Workspace-set reconciliation
 * door. The returned Personal id is the value callers may safely project into
 * a later channel-list cache commit; an absent marker is cleared first so a
 * stale value cannot be written back from an older in-memory context.
 */
export async function reconcileStoredWorkspaceSelection(
  pubkey: string,
  workspaces: readonly { communityId: string }[],
  activeWorkspaceId: string | null,
  personalWorkspaceId: string | null | undefined,
  storage: WorkspaceSelectionStorage = {
    loadPersonalId: loadPersonalCommunityId,
    saveActiveId: saveActiveCommunityId,
    clearPersonalId: clearPersonalCommunityId,
  },
  reconciliation: 'authoritative' | 'preserve' = 'authoritative',
): Promise<string | null> {
  const persistedPersonalWorkspaceId =
    personalWorkspaceId === undefined
      ? await storage.loadPersonalId(pubkey)
      : personalWorkspaceId;
  const confirmedIds = new Set(workspaces.map((workspace) => workspace.communityId));
  const nextPersonalWorkspaceId =
    reconciliation === 'preserve' ||
    (persistedPersonalWorkspaceId && confirmedIds.has(persistedPersonalWorkspaceId))
      ? persistedPersonalWorkspaceId
      : null;
  if (persistedPersonalWorkspaceId && !nextPersonalWorkspaceId) {
    await storage.clearPersonalId(pubkey);
  }
  await storage.saveActiveId(pubkey, activeWorkspaceId);
  return nextPersonalWorkspaceId;
}

export async function loadLastViewedChannel(
  pubkey: string,
  communityId: string | null,
): Promise<string | null> {
  return AsyncStorage.getItem(lastChannelKey(pubkey, communityId));
}

export async function saveLastViewedChannel(
  pubkey: string,
  communityId: string | null,
  channelId: string,
): Promise<void> {
  await AsyncStorage.setItem(lastChannelKey(pubkey, communityId), channelId);
}
