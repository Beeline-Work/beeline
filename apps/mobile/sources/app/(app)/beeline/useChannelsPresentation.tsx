import { useTextDraft } from '@/buzz/use-text-draft';
import { useRoomSearch } from '@/buzz/use-room-search';
import { filterConversations, roomListCounts, useRoomPins, useRoomListFilter } from '@/buzz/room-list-preferences';
import { roomListSections } from '@/buzz/room-list-row';
import { workspaceRailItem } from '@/buzz/room-view-presentation';
import { surfaceAddress } from '@/buzz/surface-storage';
import { useMessageSearch } from '@/buzz/use-message-search';
import { useSurfaceSnapshot } from '@/buzz/use-shared-surface';
import { RoomViewClient } from '@/sync/transport/room-view-client';
import { isWorkspaceView, type ChatListView, type Identity, type WorkspaceListView, type WorkspaceView } from '@beeline/buzz-client';
import { useMemo } from 'react';

type Props = [
  workspaceList: WorkspaceListView | null,
  requestedWorkspaceId: string | undefined,
  chatList: ChatListView | null,
  identity: Identity,
  relayUrl: string,
];
export function useChannelsPresentation([
  workspaceList, requestedWorkspaceId, chatList, identity, relayUrl,
]: Props): [
  viewerIsAgent: boolean,
  canManageWorkspace: boolean,
  activeCommunityId: string,
  togglePin: (id: string) => Promise<void>,
  roomName: string,
  roomNameDraft: import("@/buzz/text-draft-store").TextDraft<string>,
  activeCommunity: { avatar?: string | undefined; communityId: string; name: string; } | null,
  communities: { avatar?: string | undefined; communityId: string; name: string; }[],
  filter: import("@/buzz/room-list-preferences").RoomListFilter,
  setFilter: (next: import("@/buzz/room-list-preferences").RoomListFilter) => void,
  searchOpen: boolean,
  setSearchOpen: import("react/index").Dispatch<import("react/index").SetStateAction<boolean>>,
  query: string,
  setQuery: import("react/index").Dispatch<import("react/index").SetStateAction<string>>,
  counts: { all: number; unread: number; pinned: number; },
  pinError: string | null,
  setRoomName: (update: string | ((previous: string) => string)) => void,
  chatSections: import("@/buzz/room-list-row").RoomListSection[],
  messageSearch: import("@/buzz/use-message-search").MessageSearchState,
  pinned: readonly string[],
  workspaceDetail: WorkspaceView | null,
] {


  const communities = useMemo(
    () => workspaceList?.workspaces.map(workspaceRailItem) ?? [],
    [workspaceList],
  );
  const activeCommunityId =
    requestedWorkspaceId ?? chatList?.workspace.id ?? communities[0]?.communityId ?? null;
  const workspaceDetailAddress = useMemo(
    () =>
      identity && relayUrl && activeCommunityId
        ? surfaceAddress(relayUrl, identity.publicKey, '/workspace/:id', {
            workspaceId: activeCommunityId,
          })
        : null,
    [identity?.publicKey, relayUrl, activeCommunityId],
  );
  const workspaceDetail = useSurfaceSnapshot(workspaceDetailAddress, isWorkspaceView);
  const activeCommunity =
    communities.find((entry) => entry.communityId === activeCommunityId) ?? null;
  const viewerIsAgent = chatList?.viewer.kind === 'agent';
  const canManageWorkspace =
    chatList?.workspace.role === 'owner' || chatList?.workspace.role === 'admin';
  const [roomName, setRoomName, roomNameDraft] = useTextDraft(
    `new-room:${activeCommunityId}`,
    '',
    identity?.publicKey ?? null,
  );
  const { query, setQuery, searchOpen, setSearchOpen } = useRoomSearch(
    activeCommunityId ?? null,
    identity?.publicKey ?? null,
  );
  const { pinned, pinsLoaded, togglePin, pinError } = useRoomPins(
    identity?.publicKey,
    activeCommunityId,
  );
  const counts = useMemo(
    () => roomListCounts(chatList?.chats ?? [], pinned),
    [chatList?.chats, pinned],
  );
  const [filter, setFilter] = useRoomListFilter(
    activeCommunityId,
    pinsLoaded && Boolean(chatList),
    Boolean(
      chatList?.chats.some(
        (item) => !item.closed && !item.directMessage && pinned.includes(item.room.id),
      ),
    ),
  );
  const chatSections = useMemo(
    () =>
      roomListSections(
        filterConversations(chatList?.chats ?? [], query, filter, pinned),
        !query.trim() && filter === 'all',
      ),
    [chatList?.chats, query, filter, pinned],
  );
  const searchClient = useMemo(
    () => (identity && relayUrl ? new RoomViewClient({ baseUrl: relayUrl, identity }) : null),
    [identity, relayUrl],
  );
  const messageSearch = useMessageSearch(
    searchClient
      ? (workspaceId, text, before, signal) =>
          searchClient.searchMessages(workspaceId, text, before, signal)
      : null,
    activeCommunityId,
    query,
  );
return [
    viewerIsAgent, canManageWorkspace, activeCommunityId, togglePin, roomName, roomNameDraft,
    activeCommunity, communities, filter, setFilter, searchOpen, setSearchOpen, query, setQuery,
    counts, pinError, setRoomName, chatSections, messageSearch, pinned, workspaceDetail,
  ];
}
