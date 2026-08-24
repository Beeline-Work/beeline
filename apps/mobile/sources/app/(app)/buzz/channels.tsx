import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FlatList,
  AppState,
  Alert,
  Linking,
  Platform,
  Share,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import * as WebBrowser from 'expo-web-browser';
import { router, useLocalSearchParams, type Href } from 'expo-router';
import { useFocusEffect } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  KIND_CREATE_GROUP,
  TAG_COMMUNITY,
  TAG_DIRECT_MESSAGE,
  TAG_PARENT,
  tagValue,
  tagValues,
  type Community,
  type Identity,
  type PersonProfile,
  type GitHubInstallationAccess,
} from '@beeline/buzz-client';
import {
  DEFAULT_RELAY_URL,
  getEffectiveRelayUrl,
  loadBuzzIdentity,
} from '@/auth/buzz-identity-storage';
import {
  githubInstallationRedirectUri,
  githubRepositoryRefreshFeedback,
  resumeInitialGitHubInstallation,
  runGitHubInstallationSession,
} from '@/auth/github-auth-session';
import { authSessionOptions } from '@/auth/auth-session';
import { saveLastViewedChannel } from '@/buzz/community-storage';
import { createCommunityInviteUrl } from '@/buzz/community-invite';
import { prepareWorkspaceContext } from '@/buzz/workspace-bootstrap';
import { loadSuccessionPredecessors } from '@/buzz/succession-chain';
import { isWorkspaceManagerRole } from '@/buzz/workspace-role';
import { runRoomDeckComposeAction } from '@/buzz/room-deck-compose-actions';
import { formatRoomParticipantTotal, roomParticipantPubkeys } from '@/buzz/room-participants';
import { shortMemberNpub } from '@/buzz/member-display';
import { ensurePersonNameForWorkspace } from '@/buzz/person-name';
import { resolveAgentDisplayIdentity } from '@/buzz/agent-display';
import { useAgentNameCache } from '@/buzz/agent-name-cache';
import { compactRelativeTime } from '@/buzz/relative-time';
import { isRoomUnread, roomReadAt, useRoomReadState } from '@/buzz/room-read-state';
import { isRoomRemoved, useRemovedRooms } from '@/buzz/removed-rooms';
import { isCornerClosed, useClosedCorners } from '@/buzz/closed-corners';
import { NO_ACTIVITY_PREVIEW, roomListFeed, type RoomRowPresentation } from '@/buzz/room-list-row';
import { cornerVisualState, sortCorners, type CornerSummary } from '@/buzz/corners';
import { cornerHref } from '@/buzz/corner-navigation';
import {
  CHANGES_LABEL,
  CORNER_LABEL,
  MEMBERS_GLYPH,
  MEMBERS_LABEL,
  ROOM_LABEL,
  ROOMS_LABEL,
  WORKSPACE_LABEL,
} from '@/buzz/vocabulary';
import { CommunityInviteEntry } from '@/components/buzz/CommunityInviteEntry';
import { BuzzCommunityShell, CommunityDrawerTrigger } from '@/components/buzz/CommunityRail';
import { BuzzRigTransport } from '@/sync/transport';
import { Typography } from '@/constants/Typography';
import {
  mergedRepoName,
  selectChannelList,
  channelListCacheKey,
  getCachedChannel,
  mergeChannelBasicsWithCache,
  setActiveBuzzCacheViewer,
  useBuzzLocalCache,
  type ChannelDisplayItem,
  type DirectMessageDisplayItem,
  type WorkspaceMemberDisplayItem,
} from '@/buzz/local-cache';
import { sessionEventHasTag, sessionEventTagValue } from '@/sync/transport/buzz-event-projection';
import { IdentityMark } from '@/components/buzz/IdentityMark';
import {
  cacheLiveSessionEvents,
  refreshRoomListCornersForUnknownSignals,
  revalidateCachedMessages,
} from '@/buzz/local-cache-sync';
import { afterInteractions } from '@/buzz/defer-interaction';
import type { SessionEvent } from '@/sync/transport';
import {
  BrittlePress,
  CornerGlyph,
  HullDeckMark,
  MonoButton,
  PixelGateReveal,
  PixelLoader,
} from '@/components/buzz/MonoHull';
import { RepoPicker } from '@/components/buzz/RepoPicker';
import { DirectMessagePickerSheet } from '@/components/buzz/DirectMessagePickerSheet';
import {
  RoomDeckComposeMenu,
  type RoomDeckComposeAction,
} from '@/components/buzz/RoomDeckComposeMenu';
import type { RepoCandidate } from '@/buzz/room-repo-picker';

/** Relative ages only change on the minute, so the index re-derives them on a
 * one-minute tick while it is the focused screen and never on a render loop. */
const AGE_TICK_MS = 60_000;

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * How many person-facing messages this Room holds past the reader's mark, or
 * `null` when that answer is only "unread" — either there is no mark yet or
 * no local transcript to count against. The pill never invents a number.
 */
function unreadCountFor(
  room: ChannelDisplayItem,
  viewerPubkey: string | undefined,
  readAt: Record<string, number>,
): number | null {
  if (!viewerPubkey) return null;
  const mark = roomReadAt(readAt, viewerPubkey, room.id);
  if (mark === undefined || !room.latestMessageAt || room.latestMessageAt <= mark) return null;
  const messages = getCachedChannel(viewerPubkey, room.id)?.messages;
  if (!messages) return null;
  const markMs = mark * 1000;
  const count = messages.filter(
    (message) => !message.isUser && !message.isSystemNotice && message.timestamp > markMs,
  ).length;
  return count > 0 ? count : null;
}

async function loadDisplayChannelBasics(
  transport: BuzzRigTransport,
  activeCommunityId: string | null,
  communities: Community[],
): Promise<ChannelDisplayItem[]> {
  const client = await transport.ensureClient();

  if (activeCommunityId) {
    // One create-event scan carries the Workspace, parent linkage, name, and
    // creation time for every Room. Keep only top-level Rooms before doing the
    // exact metadata reads, so Corners do not create an N+1 bootstrap path.
    const [creates, memberships] = await Promise.all([
      client.query([{ kinds: [KIND_CREATE_GROUP], limit: 500 }]),
      client.listMyChannels(),
    ]);
    const membershipIds = new Set(memberships.map(({ channelId }) => channelId));
    const roomCreates = new Map<string, (typeof creates)[number]>();
    for (const create of creates) {
      if (tagValue(create, TAG_COMMUNITY) !== activeCommunityId) continue;
      if (tagValue(create, TAG_PARENT)) continue;
      if (tagValues(create, 't').includes(TAG_DIRECT_MESSAGE)) continue;
      const id = tagValue(create, 'h') ?? tagValue(create, 'd');
      if (!id || id === activeCommunityId) continue;
      if (!membershipIds.has(id)) continue;
      const prior = roomCreates.get(id);
      if (!prior || create.created_at < prior.created_at) roomCreates.set(id, create);
    }
    const rooms = await Promise.all(
      [...roomCreates.entries()].map(async ([id, create]) => {
        const metadata = await client.getChannelMetadata(id);
        return {
          id,
          active: !metadata?.archived,
          title:
            metadata?.name ??
            tagValue(create, 'name') ??
            `${ROOM_LABEL.toLowerCase()} ${id.slice(0, 8)}`,
          updatedAt: metadata?.raw?.created_at ?? create.created_at,
          createdAt: create.created_at,
          archived: metadata?.archived,
        } satisfies ChannelDisplayItem;
      }),
    );
    // Top-level Rooms only, archived ones included: an archived Room remains
    // reachable inline in DOESN'T NEED YOU unless its viewer-local removal
    // tombstone filters it from the deck projection below.
    return rooms.sort(
      (a, b) => (b.updatedAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.createdAt ?? 0),
    );
  }

  const all = await transport.sessionsRead();
  const communityIds = new Set(communities.map((community) => community.communityId));
  const memberships = await Promise.all(
    all.map(async (channel) => ({
      channel,
      communityId: await client.getChannelCommunityId(channel.id),
    })),
  );
  const standalone: ChannelDisplayItem[] = memberships
    .filter(({ channel, communityId }) => !communityId && !communityIds.has(channel.id))
    .map(({ channel }) => ({ ...channel }));
  const resolved: ChannelDisplayItem[] = await Promise.all(
    standalone.map(async (channel): Promise<ChannelDisplayItem> => {
      try {
        const parentId = await transport.getParentChannelId(channel.id);
        const archived = channel.archived ?? (await transport.isChannelArchived(channel.id));
        return { ...channel, archived, parentChannelId: parentId ?? undefined };
      } catch {
        return channel;
      }
    }),
  );
  return resolved.filter((item) => !item.parentChannelId);
}

async function loadWorkspaceRoster(
  transport: BuzzRigTransport,
  communityId: string,
  viewerPubkey: string,
): Promise<{
  members: WorkspaceMemberDisplayItem[];
  profiles: PersonProfile[];
  canEditAvatar: boolean;
}> {
  const client = await transport.ensureClient();
  const [workspaceMembers, agents] = await Promise.all([
    client.communityMembers(communityId),
    client.listAgents(communityId),
  ]);
  // Warm the device-wide agent-name store: a name learned here names the
  // agent in every Room, including ones whose own roster read never lands.
  useAgentNameCache.getState().rememberAgents(agents);
  const agentsByPubkey = new Map(agents.map((agent) => [agent.pubkey, agent]));
  const people = workspaceMembers.filter(
    (member) => member.pubkey !== viewerPubkey && !agentsByPubkey.has(member.pubkey),
  );
  const profiles = await client.listPersonProfiles(
    communityId,
    people.map((person) => person.pubkey),
  );
  const profileByPubkey = new Map(profiles.map((profile) => [profile.pubkey, profile]));
  const members: WorkspaceMemberDisplayItem[] = [
    ...people.map((person) => ({
      peerPubkey: person.pubkey,
      peerName: profileByPubkey.get(person.pubkey)?.name ?? shortMemberNpub(person.pubkey),
      peerKind: 'person' as const,
      avatarUrl: profileByPubkey.get(person.pubkey)?.avatar,
      role: person.role,
    })),
    ...agents
      .filter((agent) => agent.pubkey !== viewerPubkey)
      .map((agent) => {
        const display = resolveAgentDisplayIdentity(agent.pubkey, agent);
        return {
          peerPubkey: agent.pubkey,
          peerName: display.name,
          peerKind: 'agent' as const,
          peerAgent: agent,
          avatarUrl: display.avatarUrl,
        };
      }),
  ].sort((a, b) => a.peerName.localeCompare(b.peerName));
  const viewerRole = workspaceMembers.find((member) => member.pubkey === viewerPubkey)?.role;
  return {
    members,
    profiles,
    canEditAvatar: isWorkspaceManagerRole(viewerRole),
  };
}

async function loadDirectMessageDisplays(
  transport: BuzzRigTransport,
  communityId: string,
  viewerPubkey: string,
  roster: WorkspaceMemberDisplayItem[],
): Promise<DirectMessageDisplayItem[]> {
  const client = await transport.ensureClient();
  const rosterByPubkey = new Map(roster.map((member) => [member.peerPubkey, member]));
  const dms = await client.listDirectMessages(communityId);
  const displays = await Promise.all(
    dms.map(async (dm): Promise<DirectMessageDisplayItem | null> => {
      const peerPubkey = dm.participants.find((pubkey) => pubkey !== viewerPubkey);
      if (!peerPubkey) return null;
      const member = rosterByPubkey.get(peerPubkey);
      if (!member) return null;
      const synced = await revalidateCachedMessages(transport, viewerPubkey, dm.channelId);
      return {
        id: dm.channelId,
        ...member,
        latestMessage: synced.entry.latestMessage,
        latestMessageAt: synced.entry.latestMessageAt,
        updatedAt: synced.entry.latestEventAt ?? dm.createdAt,
      };
    }),
  );
  return displays
    .filter((dm): dm is DirectMessageDisplayItem => dm !== null)
    .sort((a, b) => b.updatedAt - a.updatedAt || a.peerName.localeCompare(b.peerName));
}

async function enrichDisplayChannels(
  transport: BuzzRigTransport,
  rooms: ChannelDisplayItem[],
  activeCommunityId: string | null,
  viewerPubkey: string,
): Promise<ChannelDisplayItem[]> {
  const client = await transport.ensureClient();
  const [workspacePeople, workspaceAgents, cornersByRoom] = await Promise.all([
    activeCommunityId ? client.communityMembers(activeCommunityId) : Promise.resolve(undefined),
    activeCommunityId ? client.listAgents(activeCommunityId) : Promise.resolve(undefined),
    // One cross-Room batched fetch for every Room's corners instead of one
    // call graph per Room.
    transport
      .listSubchannelLifecycleForRooms(rooms.map((room) => room.id))
      .catch(() => new Map<string, CornerSummary[]>()),
  ]);
  // One model-catalog read per registered Workspace agent (not per Room): the
  // pill strip reports which model an agent in this Room runs, straight off
  // the catalog the daemon itself publishes. Best-effort — a Room whose agents
  // publish nothing simply carries no model pill.
  const modelByAgent = new Map<string, string>();
  if (activeCommunityId) {
    await Promise.all(
      (workspaceAgents ?? []).map(async (agent) => {
        try {
          const catalog = await client.getAgentModelCatalog(activeCommunityId, agent.pubkey);
          const model = catalog?.selection?.model;
          if (model) modelByAgent.set(agent.pubkey, model);
        } catch {
          // No catalog yet — leave the Room's pill off rather than guess.
        }
      }),
    );
  }
  const enriched = await Promise.all(
    rooms.map(async (room): Promise<ChannelDisplayItem> => {
      const [synced, members, repo] = await Promise.allSettled([
        revalidateCachedMessages(transport, viewerPubkey, room.id),
        client.listMembers(room.id),
        // The repo name is published Room state (admin-authored binding),
        // never derived from cwd or pairing history. The tri-state read keeps
        // "could not confirm" distinct from "there isn't one", so a transient
        // refusal or an unreadable role projection cannot strip the title
        // line's repo tag — `mergedRepoName` keeps the previous name then.
        transport.roomRepositoryState(room.id),
      ]);
      const roomMemberPubkeys =
        members.status === 'fulfilled' ? members.value.map((member) => member.pubkey) : [];
      return {
        ...room,
        corners: sortCorners(cornersByRoom.get(room.id) ?? []),
        latestMessage: synced.status === 'fulfilled' ? synced.value.entry.latestMessage : undefined,
        latestMessageAt:
          synced.status === 'fulfilled' ? synced.value.entry.latestMessageAt : undefined,
        latestMessageAuthor:
          synced.status === 'fulfilled' ? synced.value.entry.latestMessageAuthor : undefined,
        updatedAt:
          synced.status === 'fulfilled'
            ? (synced.value.entry.latestEventAt ?? room.createdAt ?? room.updatedAt)
            : (room.createdAt ?? room.updatedAt),
        participantCount:
          members.status === 'fulfilled'
            ? roomParticipantPubkeys(new Set(roomMemberPubkeys), workspacePeople, workspaceAgents)
                .size
            : 0,
        repoName: mergedRepoName(
          room.repoName,
          repo.status === 'fulfilled' ? repo.value : undefined,
        ),
        modelLabel:
          roomMemberPubkeys.length > 0
            ? (roomMemberPubkeys.map((pubkey) => modelByAgent.get(pubkey)).find(Boolean) ??
              room.modelLabel)
            : room.modelLabel,
      };
    }),
  );

  return enriched.sort(
    (a, b) => (b.updatedAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.createdAt ?? 0),
  );
}

async function loadDisplayChannels(
  transport: BuzzRigTransport,
  activeCommunityId: string | null,
  communities: Community[],
  viewerPubkey: string,
): Promise<ChannelDisplayItem[]> {
  const basics = await loadDisplayChannelBasics(transport, activeCommunityId, communities);
  return enrichDisplayChannels(transport, basics, activeCommunityId, viewerPubkey);
}

export default function BuzzChannels() {
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{
    communityId?: string | string[];
    inviteUrl?: string | string[];
  }>();
  const requestedCommunity = firstParam(params.communityId);
  const inviteUrl = firstParam(params.inviteUrl);
  const initialCacheState = useBuzzLocalCache.getState();
  const initialListCache = selectChannelList(
    initialCacheState,
    initialCacheState.activeViewerPubkey,
    requestedCommunity,
  );

  const [identity, setIdentity] = useState<Identity | null>(null);
  const [transport, setTransport] = useState<BuzzRigTransport | null>(null);
  const [communities, setCommunities] = useState<Community[]>(initialListCache?.communities ?? []);
  const [activeCommunityId, setActiveCommunityId] = useState<string | null>(
    initialListCache?.communityId ?? null,
  );
  const [personalWorkspaceId, setPersonalWorkspaceId] = useState<string | null>(
    initialListCache?.personalWorkspaceId ?? null,
  );
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [relayUrl, setRelayUrl] = useState(DEFAULT_RELAY_URL);
  const [showCreateChannel, setShowCreateChannel] = useState(false);
  const [memberPickerVisible, setMemberPickerVisible] = useState(false);
  const [messagingPubkey, setMessagingPubkey] = useState<string | null>(null);
  const [channelName, setChannelName] = useState('');
  const [creatingChannel, setCreatingChannel] = useState(false);
  // Optional repo step: leave `pendingRepo` null for a chat-only Room.
  const [showRepoPicker, setShowRepoPicker] = useState(false);
  const [pendingRepo, setPendingRepo] = useState<RepoCandidate | null>(null);
  const [repoCandidates, setRepoCandidates] = useState<RepoCandidate[]>([]);
  const [githubInstallations, setGitHubInstallations] = useState<GitHubInstallationAccess[]>([]);
  const [repoPickerError, setRepoPickerError] = useState<string | null>(null);
  const [repoPickerNotice, setRepoPickerNotice] = useState<string | null>(null);
  const [viewerIsAgent, setViewerIsAgent] = useState(initialListCache?.viewerIsAgent ?? false);
  const [viewerAvatarUrl, setViewerAvatarUrl] = useState<string | undefined>(
    initialListCache?.viewerAvatarUrl,
  );
  const [canEditWorkspaceAvatar, setCanEditWorkspaceAvatar] = useState(
    initialListCache?.canEditWorkspaceAvatar ?? false,
  );
  const [creatingInvite, setCreatingInvite] = useState(false);
  const [leavingWorkspaceId, setLeavingWorkspaceId] = useState<string | null>(null);
  const [readyInviteUrl, setReadyInviteUrl] = useState<string | undefined>(inviteUrl);
  const [expandedRoomId, setExpandedRoomId] = useState<string | null>(null);
  const [ageNow, setAgeNow] = useState(() => Date.now());
  /** Rooms where an agent turn is streaming RIGHT NOW, seen live by this
   * screen's own event subscription. Corner turns are durable relay state
   * (they arrive through `corners`); conversational Room turns only exist on
   * the wire while they run, so they are tracked here from live events and
   * deliberately reset when the subscription tears down.
   */
  const [liveTurnRooms, setLiveTurnRooms] = useState<ReadonlySet<string>>(() => new Set());
  const skipInitialFocusRefresh = useRef(true);
  const loadGeneration = useRef(0);
  const visibleRefreshGeneration = useRef<number | null>(null);
  const readAt = useRoomReadState((state) => state.readAt);
  const markRoomRead = useRoomReadState((state) => state.markRoomRead);
  // Durable local tombstones: Rooms this viewer left, plus legacy Deletes
  // recorded before authoritative kind:9008 deletion shipped. The relay may
  // keep returning an archived Room (its membership projection can still name
  // us after a refused leave), so the deck itself filters these out on every
  // build — cache seed, refresh, and restart alike.
  const removedAt = useRemovedRooms((state) => state.removedAt);
  // Closed-corner tombstones (#corner-close): a corner this viewer dismissed
  // leaves the deck's counts and dropdowns on the frame the close lands,
  // not a daemon maintenance tick later.
  const closedCornerAt = useClosedCorners((state) => state.closedAt);
  // The Room the reader just left. Marking read on the way *back* — not on the
  // way in — is what keeps a message you sent, or one that arrived while you
  // were looking at it, from lighting the row up as unread on return.
  const returningFromChannelId = useRef<string | null>(null);
  const cachedListEntry = useBuzzLocalCache((state) =>
    selectChannelList(state, identity?.publicKey ?? state.activeViewerPubkey, requestedCommunity),
  );
  const displayChannels = cachedListEntry?.channels ?? [];
  const directMessages = cachedListEntry?.directMessages ?? [];
  const roomIdsKey = useMemo(
    () =>
      displayChannels
        .map((channel) => channel.id)
        .sort()
        .join(','),
    [displayChannels],
  );
  const orderedDirectMessages = useMemo(
    () =>
      [...directMessages].sort(
        (a, b) => b.updatedAt - a.updatedAt || a.peerName.localeCompare(b.peerName),
      ),
    [directMessages],
  );
  const hasConversations = displayChannels.length > 0 || orderedDirectMessages.length > 0;
  const activeCommunity = useMemo(
    () => communities.find((community) => community.communityId === activeCommunityId) ?? null,
    [communities, activeCommunityId],
  );

  /** Pubkey → display name for the preview attribution, off the same roster the
   * list already caches. Unknown authors stay unattributed by design. */
  const authorNames = useMemo(() => {
    const names = new Map<string, string>();
    for (const member of cachedListEntry?.workspaceMembers ?? []) {
      names.set(member.peerPubkey, member.peerName);
    }
    if (identity?.publicKey) names.set(identity.publicKey, 'You');
    return names;
  }, [cachedListEntry?.workspaceMembers, identity?.publicKey]);
  const roomFeed = useMemo(() => {
    const viewerKey = identity?.publicKey ?? cachedListEntry?.viewerPubkey;
    const visible = displayChannels
      .filter((room) => !isRoomRemoved(removedAt, viewerKey, room.id))
      .map((room) => ({
        ...room,
        unreadNew: unreadCountFor(room, identity?.publicKey, readAt),
        // Unread is activity only: it bolds/floats the Room but never changes
        // the max-of-corners state circle.
        roomUnread: isRoomUnread(roomReadAt(readAt, viewerKey, room.id), room.latestMessageAt),
        agentTurnWorking: liveTurnRooms.has(room.id),
        agentTurnAt: liveTurnRooms.has(room.id) ? Math.floor(ageNow / 1000) : undefined,
        corners: (room.corners ?? []).filter(
          (corner) => !isCornerClosed(closedCornerAt, viewerKey, room.id, corner.id),
        ),
      }));
    // DMs share the same recency feed. Their own fields ride along so the row
    // renderer can draw its identity mark.
    const directEntries = orderedDirectMessages.map((dm) => ({
      ...dm,
      title: dm.peerName,
      corners: [] as ChannelDisplayItem['corners'],
      archived: false,
      roomUnread: isRoomUnread(roomReadAt(readAt, viewerKey, dm.id), dm.latestMessageAt),
    }));
    return roomListFeed([...visible, ...directEntries], authorNames, { now: ageNow });
  }, [
    ageNow,
    authorNames,
    cachedListEntry?.viewerPubkey,
    closedCornerAt,
    displayChannels,
    identity?.publicKey,
    liveTurnRooms,
    orderedDirectMessages,
    readAt,
    removedAt,
  ]);

  useEffect(() => {
    let cancelled = false;
    const generation = ++loadGeneration.current;
    const isCurrent = () => !cancelled && loadGeneration.current === generation;
    skipInitialFocusRefresh.current = true;
    void (async () => {
      setError(null);
      try {
        const currentIdentity = await loadBuzzIdentity();
        if (!currentIdentity) {
          router.replace('/buzz/onboarding');
          return;
        }
        setActiveBuzzCacheViewer(currentIdentity.publicKey);

        // Publish the identity before touching the relay. The cache selector is
        // keyed by this pubkey, so holding it back behind ensureClient() made a
        // perfectly good persisted Room list look empty whenever launch raced a
        // slow or unavailable connection.
        const cached = selectChannelList(
          useBuzzLocalCache.getState(),
          currentIdentity.publicKey,
          requestedCommunity,
        );
        if (isCurrent()) {
          setIdentity(currentIdentity);
          setCommunities(cached?.communities ?? []);
          setActiveCommunityId(cached?.communityId ?? null);
          setPersonalWorkspaceId(cached?.personalWorkspaceId ?? null);
          setViewerIsAgent(cached?.viewerIsAgent ?? false);
          setViewerAvatarUrl(cached?.viewerAvatarUrl);
          setCanEditWorkspaceAvatar(cached?.canEditWorkspaceAvatar ?? false);
        }
        const url = await getEffectiveRelayUrl();
        const nextTransport = new BuzzRigTransport(currentIdentity, url);
        if (isCurrent()) {
          setRelayUrl(url);
          setTransport(nextTransport);
        }
        const client = await nextTransport.ensureClient();
        const bootstrapOptions = {
          loadPredecessors: () => loadSuccessionPredecessors(url, currentIdentity),
        };
        const [workspaceContext, identityIsAgent] = await Promise.all([
          prepareWorkspaceContext(
            client,
            currentIdentity.publicKey,
            requestedCommunity,
            undefined,
            bootstrapOptions,
          ),
          client.isAgentIdentity(currentIdentity.publicKey),
        ]);
        const {
          workspaces: available,
          activeWorkspaceId: active,
          personalWorkspaceId: personal,
        } = workspaceContext;
        await ensurePersonNameForWorkspace(client, active, currentIdentity.publicKey);
        const channels = await loadDisplayChannelBasics(nextTransport, active, available);
        if (isCurrent()) {
          setCommunities(available);
          setActiveCommunityId(active);
          setPersonalWorkspaceId(personal);
          setViewerIsAgent(identityIsAgent);
          const cacheState = useBuzzLocalCache.getState();
          const existing =
            cacheState.channelLists[channelListCacheKey(currentIdentity.publicKey, active)];
          const now = Date.now();
          cacheState.setChannelList({
            viewerPubkey: currentIdentity.publicKey,
            communityId: active,
            channels: mergeChannelBasicsWithCache(channels, existing?.channels),
            directMessages: existing?.directMessages ?? [],
            workspaceMembers: existing?.workspaceMembers ?? [],
            communities: available,
            personalWorkspaceId: personal,
            viewerIsAgent: identityIsAgent,
            viewerAvatarUrl: existing?.viewerAvatarUrl,
            canEditWorkspaceAvatar: existing?.canEditWorkspaceAvatar ?? false,
            updatedAt: now,
            lastAccessedAt: now,
          });
        }

        const roster = active
          ? await loadWorkspaceRoster(nextTransport, active, currentIdentity.publicKey)
          : { members: [], profiles: [], canEditAvatar: false };
        const [viewerProfile, enriched, dms] = await Promise.all([
          active
            ? client.getPersonProfile(active, currentIdentity.publicKey)
            : Promise.resolve(null),
          enrichDisplayChannels(nextTransport, channels, active, currentIdentity.publicKey),
          active
            ? loadDirectMessageDisplays(
                nextTransport,
                active,
                currentIdentity.publicKey,
                roster.members,
              )
            : Promise.resolve([]),
        ]);
        if (isCurrent()) {
          setViewerAvatarUrl(viewerProfile?.avatar);
          setCanEditWorkspaceAvatar(roster.canEditAvatar);
          const now = Date.now();
          const cacheState = useBuzzLocalCache.getState();
          cacheState.setChannelList({
            viewerPubkey: currentIdentity.publicKey,
            communityId: active,
            channels: enriched,
            directMessages: dms,
            workspaceMembers: roster.members,
            communities: available,
            personalWorkspaceId: personal,
            viewerIsAgent: identityIsAgent,
            viewerAvatarUrl: viewerProfile?.avatar,
            canEditWorkspaceAvatar: roster.canEditAvatar,
            updatedAt: now,
            lastAccessedAt: now,
          });
          if (active) {
            cacheState.replaceProfiles(currentIdentity.publicKey, active, [
              ...roster.profiles,
              ...(viewerProfile ? [viewerProfile] : []),
            ]);
          }
        }
      } catch (err) {
        if (isCurrent()) setError(String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [requestedCommunity]);

  const handleSelectCommunity = useCallback((communityId: string | null) => {
    if (!communityId) return;
    setReadyInviteUrl(undefined);
    setExpandedRoomId(null);
    router.replace({
      pathname: '/buzz/channels',
      params: { communityId },
    });
  }, []);

  /** Exit one Workspace from the rail's long-press affordance. The relay does
   * the real work — the SDK leaves this member's top-level Rooms best-effort,
   * then publishes the self-authored Workspace removal and waits for the
   * projection to drop it, so a refusal (e.g. the sole owner of a Workspace)
   * surfaces here as an honest dialog instead of a silent no-op. */
  const handleLeaveWorkspace = useCallback(
    (communityId: string) => {
      const community = communities.find((entry) => entry.communityId === communityId);
      Alert.alert(
        `Exit ${community?.name ?? WORKSPACE_LABEL}?`,
        `Leaving removes this ${WORKSPACE_LABEL} from your list. Its ${ROOMS_LABEL.toLowerCase()} and agents are unaffected for other members, and you can be re-invited later.`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Exit',
            style: 'destructive',
            onPress: () => {
              if (!transport || !identity || leavingWorkspaceId) return;
              setLeavingWorkspaceId(communityId);
              void transport
                .leaveWorkspace(communityId)
                .then(() => {
                  const remaining = communities.filter(
                    (entry) => entry.communityId !== communityId,
                  );
                  setCommunities(remaining);
                  const nextActive =
                    activeCommunityId === communityId
                      ? (remaining[0]?.communityId ?? null)
                      : activeCommunityId;
                  if (nextActive) {
                    useBuzzLocalCache.getState().patchChannelList(identity.publicKey, nextActive, {
                      communities: remaining,
                    });
                  }
                  if (activeCommunityId === communityId) {
                    setExpandedRoomId(null);
                    router.replace({
                      pathname: '/buzz/channels',
                      ...(nextActive ? { params: { communityId: nextActive } } : {}),
                    });
                  }
                })
                .catch((err) => {
                  Alert.alert(`Could not exit ${community?.name ?? WORKSPACE_LABEL}`, String(err));
                })
                .finally(() => setLeavingWorkspaceId(null));
            },
          },
        ],
      );
    },
    [activeCommunityId, communities, identity, leavingWorkspaceId, transport],
  );

  const handleRefresh = useCallback(
    async (showSpinner: boolean) => {
      if (!transport || !identity) return;
      const generation = ++loadGeneration.current;
      const isCurrent = () => loadGeneration.current === generation;
      if (showSpinner) {
        visibleRefreshGeneration.current = generation;
        setRefreshing(true);
      }
      setError(null);
      try {
        const client = await transport.ensureClient();
        const {
          workspaces: available,
          activeWorkspaceId: active,
          personalWorkspaceId: personal,
        } = await prepareWorkspaceContext(
          client,
          identity.publicKey,
          activeCommunityId ?? undefined,
          undefined,
          {
            loadPredecessors: async () =>
              loadSuccessionPredecessors(
                relayUrl && relayUrl !== DEFAULT_RELAY_URL
                  ? relayUrl
                  : await getEffectiveRelayUrl(),
                identity,
              ),
          },
        );
        await ensurePersonNameForWorkspace(client, active, identity.publicKey);
        if (!isCurrent()) return;
        setCommunities(available);
        setActiveCommunityId(active);
        setPersonalWorkspaceId(personal);
        const channels = await loadDisplayChannelBasics(transport, active, available);
        if (!isCurrent()) return;
        const cacheState = useBuzzLocalCache.getState();
        const existing = cacheState.channelLists[channelListCacheKey(identity.publicKey, active)];
        cacheState.patchChannelList(identity.publicKey, active, {
          channels: mergeChannelBasicsWithCache(channels, existing?.channels),
          communities: available,
        });
        const roster = active
          ? await loadWorkspaceRoster(transport, active, identity.publicKey)
          : { members: [], profiles: [], canEditAvatar: false };
        const [enriched, viewerProfile, dms] = await Promise.all([
          enrichDisplayChannels(transport, channels, active, identity.publicKey),
          active ? client.getPersonProfile(active, identity.publicKey) : Promise.resolve(undefined),
          active
            ? loadDirectMessageDisplays(transport, active, identity.publicKey, roster.members)
            : Promise.resolve([]),
        ]);
        if (!isCurrent()) return;
        setViewerAvatarUrl(viewerProfile?.avatar);
        setCanEditWorkspaceAvatar(roster.canEditAvatar);
        const now = Date.now();
        cacheState.setChannelList({
          viewerPubkey: identity.publicKey,
          communityId: active,
          channels: enriched,
          directMessages: dms,
          workspaceMembers: roster.members,
          communities: available,
          personalWorkspaceId: personal,
          viewerIsAgent,
          viewerAvatarUrl: viewerProfile?.avatar,
          canEditWorkspaceAvatar: roster.canEditAvatar,
          updatedAt: now,
          lastAccessedAt: now,
        });
        if (active) {
          cacheState.replaceProfiles(identity.publicKey, active, [
            ...roster.profiles,
            ...(viewerProfile ? [viewerProfile] : []),
          ]);
        }
      } catch (err) {
        if (isCurrent()) setError(String(err));
      } finally {
        if (visibleRefreshGeneration.current === generation) {
          visibleRefreshGeneration.current = null;
          setRefreshing(false);
        }
      }
    },
    [activeCommunityId, identity, transport, viewerIsAgent],
  );

  // A newly-created Workspace is already relay-backed, but device Back can reveal
  // an older mounted home screen. Refresh on focus so its switcher is never stale.
  //
  // This refresh re-reads and re-projects every Room's transcript, so it must
  // not run on the back-navigation transition itself — that work belongs
  // behind the interaction, not inside it.
  useFocusEffect(
    useCallback(() => {
      if (!transport || !identity) return;
      if (skipInitialFocusRefresh.current) {
        skipInitialFocusRefresh.current = false;
        return;
      }
      const cancel = afterInteractions(() => void handleRefresh(false));
      return cancel;
    }, [handleRefresh, identity, transport]),
  );

  // Room previews are a live projection, not a creation-time cache field.
  // Keep the list current while it is visible; cacheLiveSessionEvents also
  // writes the same fresh summary to MMKV on the next background transition.
  //
  // The same stream also feeds the deck's WORKING state for conversational
  // Room turns: an `agent-turn` working event (or a streaming draft) marks the
  // Room live until its complete/failed lands. Corner turns need none of this
  // — their lifecycle is durable relay state read through `corners`.
  //
  // Coalesce per animation frame. A corner streaming its reply delivers one
  // raw event per token, and `cacheLiveSessionEvents` rebuilds and re-sorts
  // that Room's whole message array per call, then notifies every store
  // subscriber. Feeding it one event at a time made a live agent turn in any
  // listed Room saturate the JS thread while this screen was on top.
  useFocusEffect(
    useCallback(() => {
      if (!transport || !identity || !roomIdsKey) return;
      const pending = new Map<string, SessionEvent[]>();
      let flushScheduled = false;
      let stopped = false;
      const noteTurnEvent = (channelId: string, event: SessionEvent) => {
        const isTurn = sessionEventHasTag(event, 't', 'agent-turn');
        const isDraft = sessionEventHasTag(event, 't', 'agent-draft');
        if (!isTurn && !isDraft) return;
        const status = sessionEventTagValue(event, 'status');
        const finished = status === 'complete' || status === 'failed';
        setLiveTurnRooms((current) => {
          const has = current.has(channelId);
          if (finished === !has) return current; // no change
          const next = new Set(current);
          if (finished) next.delete(channelId);
          else next.add(channelId);
          return next;
        });
      };
      const flush = () => {
        flushScheduled = false;
        if (stopped || pending.size === 0) return;
        const batches = [...pending.entries()];
        pending.clear();
        for (const [channelId, events] of batches) {
          const projections = cacheLiveSessionEvents(identity.publicKey, channelId, events);
          void refreshRoomListCornersForUnknownSignals(
            transport,
            identity.publicKey,
            channelId,
            projections,
          );
        }
      };
      const unsubscribes = roomIdsKey.split(',').map((channelId) =>
        transport.sessionEventsSubscribe(channelId, (event) => {
          if (stopped) return;
          noteTurnEvent(channelId, event);
          const queued = pending.get(channelId);
          if (queued) queued.push(event);
          else pending.set(channelId, [event]);
          if (!flushScheduled) {
            flushScheduled = true;
            requestAnimationFrame(flush);
          }
        }),
      );
      return () => {
        stopped = true;
        unsubscribes.forEach((unsubscribe) => unsubscribe());
        setLiveTurnRooms(new Set());
      };
    }, [identity, roomIdsKey, transport]),
  );

  useFocusEffect(
    useCallback(() => {
      setAgeNow(Date.now());
      const timer = setInterval(() => setAgeNow(Date.now()), AGE_TICK_MS);
      return () => clearInterval(timer);
    }, []),
  );

  // Clear the unread mark for the Room the reader has just come back from. The
  // mark takes wall-clock now over the last message we know about, so a message
  // that landed while they were inside is covered even if this list's cache has
  // not caught up with it yet.
  useFocusEffect(
    useCallback(() => {
      const channelId = returningFromChannelId.current;
      if (!channelId || !identity) return;
      returningFromChannelId.current = null;
      const known = [...displayChannels, ...directMessages].find(
        (candidate) => candidate.id === channelId,
      )?.latestMessageAt;
      markRoomRead(
        identity.publicKey,
        channelId,
        Math.max(Math.floor(Date.now() / 1000), known ?? 0),
      );
    }, [directMessages, displayChannels, identity, markRoomRead]),
  );

  const openChannel = useCallback(
    (channelId: string) => {
      returningFromChannelId.current = channelId;
      if (identity) void saveLastViewedChannel(identity.publicKey, activeCommunityId, channelId);
      router.push(`/buzz/chat/${encodeURIComponent(channelId)}` as Href);
    },
    [activeCommunityId, identity],
  );

  const handleStartDirectMessage = useCallback(
    async (member: WorkspaceMemberDisplayItem) => {
      if (!transport || !activeCommunityId || messagingPubkey) return;
      setMessagingPubkey(member.peerPubkey);
      setError(null);
      try {
        const result = await transport.resolveDirectMessage(activeCommunityId, member.peerPubkey);
        setMemberPickerVisible(false);
        openChannel(result.channelId);
      } catch (err) {
        setError(`Could not message ${member.peerName}: ${String(err)}`);
      } finally {
        setMessagingPubkey(null);
      }
    },
    [activeCommunityId, messagingPubkey, openChannel, transport],
  );

  const loadRepoPicker = useCallback(
    async (refresh = false) => {
      if (!transport || !activeCommunityId) return;
      const access = await transport.workspaceGitHubAccess({ refresh });
      setRepoCandidates(access.candidates);
      setGitHubInstallations(access.installations);
    },
    [activeCommunityId, transport],
  );

  const handleRepositoryRefreshPhase = useCallback(
    (phase: Parameters<typeof githubRepositoryRefreshFeedback>[0]) => {
      const feedback = githubRepositoryRefreshFeedback(phase);
      setRepoPickerNotice(feedback.notice);
      setRepoPickerError(feedback.error);
    },
    [],
  );

  const handleToggleRepoPicker = useCallback(async () => {
    setShowRepoPicker((value) => !value);
    if (showRepoPicker || !transport || !activeCommunityId) return;
    setRepoPickerError(null);
    try {
      await loadRepoPicker(true);
    } catch (err) {
      setRepoPickerError(`Could not load repos: ${String(err)}`);
    }
  }, [activeCommunityId, loadRepoPicker, showRepoPicker, transport]);

  const handleAddGitHubAccount = useCallback(async () => {
    if (!transport) return;
    setRepoPickerError(null);
    setRepoPickerNotice(null);
    try {
      await runGitHubInstallationSession({
        returnPath: '/buzz/channels',
        startInstallation: () => transport.githubInstallationStart(githubInstallationRedirectUri()),
        openAuthSession: (installationUrl, redirectUri) =>
          WebBrowser.openAuthSessionAsync(
            installationUrl,
            redirectUri,
            authSessionOptions(Platform.OS, redirectUri),
          ),
        subscribeToUrls: (listener) => Linking.addEventListener('url', ({ url }) => listener(url)),
        subscribeToAppState: (listener) => AppState.addEventListener('change', listener),
        refreshRepositories: () => loadRepoPicker(true),
        onRefreshPhase: handleRepositoryRefreshPhase,
      });
    } catch (err) {
      setRepoPickerError(`Could not connect GitHub: ${String(err)}`);
    }
  }, [handleRepositoryRefreshPhase, loadRepoPicker, transport]);

  const handleManageGitHubInstallation = useCallback(
    async (installation: GitHubInstallationAccess) => {
      if (!transport) return;
      setRepoPickerError(null);
      setRepoPickerNotice(null);
      try {
        await runGitHubInstallationSession({
          returnPath: '/buzz/channels',
          startInstallation: () =>
            transport.githubInstallationStart(
              githubInstallationRedirectUri(),
              installation.installationId,
            ),
          openAuthSession: (installationUrl, redirectUri) =>
            WebBrowser.openAuthSessionAsync(
              installationUrl,
              redirectUri,
              authSessionOptions(Platform.OS, redirectUri),
            ),
          subscribeToUrls: (listener) =>
            Linking.addEventListener('url', ({ url }) => listener(url)),
          subscribeToAppState: (listener) => AppState.addEventListener('change', listener),
          refreshRepositories: () => loadRepoPicker(true),
          onRefreshPhase: handleRepositoryRefreshPhase,
        });
      } catch (err) {
        setRepoPickerError(`Could not connect GitHub: ${String(err)}`);
      }
    },
    [handleRepositoryRefreshPhase, loadRepoPicker, transport],
  );

  useEffect(() => {
    if (!transport || !activeCommunityId) return;
    void resumeInitialGitHubInstallation(() => Linking.getInitialURL())
      .then(async (completed) => {
        if (!completed) return;
        setShowRepoPicker(true);
        await loadRepoPicker(true);
      })
      .catch((err) => setRepoPickerError(`Could not connect GitHub: ${String(err)}`));
  }, [activeCommunityId, loadRepoPicker, transport]);

  const handleCreateGitHubRepository = useCallback(
    async (installationId: number, name: string) => {
      if (!transport) return;
      setRepoPickerError(null);
      try {
        const candidate = await transport.githubRepositoryCreate({
          installationId,
          name,
          private: true,
        });
        setRepoCandidates((current) => [...current, candidate]);
        setPendingRepo(candidate);
      } catch (err) {
        setRepoPickerError(`Could not create repo: ${String(err)}`);
        throw err;
      }
    },
    [transport],
  );

  const handleSelectRepoCandidate = useCallback((candidate: RepoCandidate) => {
    setPendingRepo(candidate);
    setShowRepoPicker(false);
    setRepoPickerError(null);
  }, []);

  const handleCreateChannel = useCallback(async () => {
    const name = channelName.trim();
    if (!name || !transport || !identity || viewerIsAgent) return;
    setCreatingChannel(true);
    setError(null);
    try {
      const client = await transport.ensureClient();
      const channelId = await client.createChannel(name, {
        ...(activeCommunityId ? { communityId: activeCommunityId } : {}),
      });
      await client.waitUntilMember(channelId, client.identity.publicKey);
      if (pendingRepo?.remote) {
        try {
          await client.setRoomRepository(channelId, {
            key: pendingRepo.key,
            name: pendingRepo.name,
            remote: pendingRepo.remote,
            ...(pendingRepo.githubInstallationId
              ? { githubInstallationId: pendingRepo.githubInstallationId }
              : {}),
            ...(pendingRepo.defaultBranch ? { targetBranch: pendingRepo.defaultBranch } : {}),
            ...(activeCommunityId ? { communityId: activeCommunityId } : {}),
          });
        } catch (err) {
          setError(`${ROOM_LABEL} created, but could not link the repo: ${String(err)}`);
        }
      }
      setChannelName('');
      setShowCreateChannel(false);
      setPendingRepo(null);
      setShowRepoPicker(false);
      const channels = await loadDisplayChannels(
        transport,
        activeCommunityId,
        communities,
        identity.publicKey,
      );
      useBuzzLocalCache
        .getState()
        .patchChannelList(identity.publicKey, activeCommunityId, { channels });
    } catch (err) {
      setError(`Could not create ${ROOM_LABEL}: ${String(err)}`);
    } finally {
      setCreatingChannel(false);
    }
  }, [
    activeCommunityId,
    channelName,
    communities,
    identity,
    pendingRepo,
    transport,
    viewerIsAgent,
  ]);

  const handleInvitePeople = useCallback(async () => {
    if (!transport || !activeCommunityId || creatingInvite) return;
    setCreatingInvite(true);
    setError(null);
    try {
      const url =
        readyInviteUrl ??
        (await createCommunityInviteUrl(
          await transport.ensureClient(),
          activeCommunityId,
          relayUrl,
        ));
      setReadyInviteUrl(url);
      await Share.share({ message: url });
    } catch (err) {
      setError(`Could not create invite: ${String(err)}`);
    } finally {
      setCreatingInvite(false);
    }
  }, [activeCommunityId, creatingInvite, readyInviteUrl, relayUrl, transport]);

  const handleComposeAction = useCallback(
    (action: RoomDeckComposeAction) => {
      runRoomDeckComposeAction(action, {
        communityId: activeCommunityId,
        openMessagePicker: () => setMemberPickerVisible(true),
        openRoomCreator: () => setShowCreateChannel(true),
        invitePerson: () => void handleInvitePeople(),
        navigate: (target) => router.push(target as unknown as Href),
      });
    },
    [activeCommunityId, handleInvitePeople],
  );

  /** One renderer for every Room in the headerless activity feed. */
  const renderRoomEntry = useCallback(
    (entry: { item: ChannelDisplayItem; row: RoomRowPresentation }) => {
      const { item, row } = entry;
      // The dropdown lists open corner work, and the CONTROL exists only
      // for open work too: finished corners (merged/archived) carry no count
      // and no expansion, while their Room remains inline in DOESN'T NEED YOU.
      const corners = row.corners;
      const canExpand = corners.length > 0;
      const title = item.title ?? `${ROOM_LABEL.toLowerCase()} ${item.id.slice(0, 8)}`;
      const expanded = canExpand && expandedRoomId === item.id;
      const age = compactRelativeTime(row.meaningfulAt, ageNow);
      // One state per row, one visual language each: needs-you (brass),
      // working (motion), idle (steel). The derivation lives in
      // `roomRowPresentation`; this only picks which mark renders.
      const deckState = row.state;
      return (
        <View style={styles.roomCell}>
          <View style={styles.roomRow}>
            <BrittlePress
              accessibilityHint={
                canExpand ? `Long press to reveal ${CORNER_LABEL.toLowerCase()}s` : undefined
              }
              accessibilityLabel={`Open ${title}${
                row.attention ? ', needs your attention' : ''
              }${row.live && !row.attention ? ', agent working' : ''}, ${formatRoomParticipantTotal(
                item.participantCount ?? 0,
              )}${canExpand ? `, ${corners.length} open ${CHANGES_LABEL}` : ''}`}
              contentStyle={styles.indexRow}
              delayLongPress={350}
              onLongPress={
                canExpand
                  ? () => setExpandedRoomId((current) => (current === item.id ? null : item.id))
                  : undefined
              }
              onPress={() => openChannel(item.id)}
              style={styles.roomPrimary}
              testID={`room-${item.id}`}
            >
              {/* Fixed-width flex mark column — the row's height is
                  established by its in-flow children, never an overlay. */}
              <View style={styles.rowMark}>
                <HullDeckMark state={deckState} />
              </View>
              <View style={styles.rowCopy}>
                <View style={styles.rowTitleLine}>
                  <Text
                    numberOfLines={1}
                    style={[
                      styles.rowTitle,
                      row.unread && styles.rowTitleUnread,
                      item.archived && styles.rowTitleArchived,
                    ]}
                  >
                    {title}
                  </Text>
                  {!!item.repoName && !item.archived && (
                    <Text numberOfLines={1} style={styles.rowRepo}>
                      {item.repoName}
                    </Text>
                  )}
                  {item.archived && <Text style={styles.rowFlag}>ARCHIVED</Text>}
                </View>
                <Text numberOfLines={1} style={styles.rowPreview}>
                  {row.fact}
                </Text>
                {/* The cell carries four things and nothing else: the
                    status mark, the name, the last-message fact, and the
                    corner count in the gutter. The old pill strip (model,
                    participants, corners-open, needs-you) was redundant —
                    the brass mark plus the accent fact already say
                    "needs you," and the gutter already carries the corner
                    count — so it is gone. */}
              </View>
            </BrittlePress>
            {/* The right gutter: a fixed marginalia column IN FLOW (a
                sibling of the pressable, never laid over the row), so
                an age stamp or a corner count can never reflow the copy
                beside it and can never escape into the next row. */}
            <View style={styles.rowGutter}>
              <Text style={styles.rowAge}>{age}</Text>
              {canExpand && (
                <TouchableOpacity
                  accessibilityLabel={`${expanded ? 'Hide' : 'Show'} ${corners.length} open ${
                    corners.length === 1 ? CORNER_LABEL : CHANGES_LABEL
                  } in ${title}`}
                  accessibilityRole="button"
                  accessibilityState={{ expanded }}
                  onPress={() =>
                    setExpandedRoomId((current) => (current === item.id ? null : item.id))
                  }
                  style={styles.cornerPeek}
                  testID={`room-corners-toggle-${item.id}`}
                >
                  {/* Bare count + fold chevron, no container — the
                      owner's call: the number IS the affordance. */}
                  <Text style={styles.cornerPeekCount}>
                    {corners.length}
                    {'\u2009'}
                    <Text style={styles.cornerPeekChevron}>{expanded ? '⌃' : '⌄'}</Text>
                  </Text>
                </TouchableOpacity>
              )}
            </View>
          </View>
          {expanded && (
            <PixelGateReveal style={styles.cornerDropdown}>
              <View style={styles.cornerRail} />
              {corners.map((corner) => {
                // Offline without an artifact folds to idle — same verdict the deck row
                // golds from; a dead agent's ask is nobody's to answer.
                const state = cornerVisualState(corner.status, corner);
                return (
                  <TouchableOpacity
                    accessibilityLabel={`Open ${corner.name} ${CORNER_LABEL}, ${state}`}
                    key={corner.id}
                    onPress={() =>
                      router.push(cornerHref(corner.id, item.id, corner.name, 'room-list'))
                    }
                    style={styles.cornerRow}
                  >
                    <CornerGlyph
                      status={corner.status}
                      awaitingReply={corner.awaitingReply}
                      agentOffline={corner.agentOffline}
                      style={styles.cornerGlyph}
                    />
                    <Text numberOfLines={1} style={styles.cornerName}>
                      {corner.name}
                    </Text>
                  </TouchableOpacity>
                );
              })}
              {/* No "all corners" row: the expansion IS the full list, so
                  a separate link into it was redundant. When a Room grows
                  past a sensible inline cap we surface "+N more" there —
                  the only case that route earns its place. */}
            </PixelGateReveal>
          )}
        </View>
      );
    },
    [ageNow, expandedRoomId, openChannel],
  );

  /** One renderer for the feed's DM rows. Their row language is identity (the
   * peer's faceted mark), while unread affects title weight only. */
  const renderDirectEntry = useCallback(
    (entry: { item: DirectMessageDisplayItem; row: RoomRowPresentation }) => {
      const dm = entry.item;
      const row = entry.row;
      const display = dm.peerAgent
        ? resolveAgentDisplayIdentity(dm.peerPubkey, dm.peerAgent)
        : undefined;
      const unread = row.unread;
      const age = compactRelativeTime(dm.latestMessageAt ?? dm.updatedAt, ageNow);
      return (
        <View style={styles.roomCell} testID={`direct-row-${dm.id}`}>
          <View style={styles.roomRow}>
            <TouchableOpacity
              accessibilityLabel={`Open direct message with ${dm.peerName}`}
              onPress={() => openChannel(dm.id)}
              style={[styles.roomPrimary, styles.indexRow]}
              testID={`direct-message-${dm.peerPubkey}`}
            >
              <View style={styles.rowMark}>
                {display ? (
                  <IdentityMark
                    kind="agent"
                    seed={display.avatarSeed ?? dm.peerPubkey}
                    avatarUrl={display.avatarUrl}
                    name={display.name}
                    size={30}
                  />
                ) : (
                  <IdentityMark
                    kind="human"
                    seed={dm.peerPubkey}
                    avatarUrl={dm.avatarUrl}
                    name={dm.peerName}
                    size={30}
                  />
                )}
              </View>
              <View style={styles.rowCopy}>
                <View style={styles.rowTitleLine}>
                  <Text
                    numberOfLines={1}
                    style={[styles.rowTitle, unread && styles.rowTitleUnread]}
                  >
                    {dm.peerName}
                  </Text>
                </View>
                <Text numberOfLines={1} style={styles.rowPreview}>
                  {dm.latestMessage ?? NO_ACTIVITY_PREVIEW}
                </Text>
              </View>
            </TouchableOpacity>
            <View pointerEvents="none" style={styles.rowGutter}>
              <Text style={styles.rowAge}>{age}</Text>
            </View>
          </View>
        </View>
      );
    },
    [ageNow, openChannel],
  );

  if (!cachedListEntry) {
    return (
      <View style={[styles.container, styles.center, { paddingTop: insets.top }]}>
        <PixelLoader />
        <Text style={styles.loadingText}>CONNECTING TO RELAY</Text>
      </View>
    );
  }

  return (
    <BuzzCommunityShell
      communities={communities}
      activeCommunityId={activeCommunityId}
      onSelect={handleSelectCommunity}
      onAdd={() => router.push('/buzz/community' as Href)}
      onSettings={() => router.push('/buzz/settings' as Href)}
      onWorkspaceSettings={(communityId) =>
        router.push({
          pathname: '/buzz/settings/workspace',
          params: { communityId },
        } as unknown as Href)
      }
      canManageActiveCommunity={canEditWorkspaceAvatar}
      onLeaveWorkspace={handleLeaveWorkspace}
      viewerPubkey={identity?.publicKey}
      viewerAvatarUrl={viewerAvatarUrl}
    >
      <View style={[styles.container, { paddingTop: insets.top }]}>
        {/* Chrome carries no surface of its own: the index and its header are
            the same slab, parted by one hairline. */}
        <View style={styles.header}>
          <CommunityDrawerTrigger community={activeCommunity} />
          {activeCommunityId && (
            <TouchableOpacity
              accessibilityLabel={`${WORKSPACE_LABEL} members`}
              accessibilityRole="button"
              onPress={() =>
                router.push(
                  `/buzz/members?communityId=${encodeURIComponent(activeCommunityId)}` as Href,
                )
              }
              style={styles.headerAction}
              testID="workspace-members"
            >
              <Text style={styles.headerActionText}>
                {MEMBERS_GLYPH} {MEMBERS_LABEL.toUpperCase()}
              </Text>
            </TouchableOpacity>
          )}
          {!viewerIsAgent && (
            <TouchableOpacity
              accessibilityLabel={
                showCreateChannel ? `Cancel new ${ROOM_LABEL}` : `Create ${ROOM_LABEL}`
              }
              accessibilityRole="button"
              accessibilityState={{ expanded: showCreateChannel }}
              onPress={() => setShowCreateChannel((value) => !value)}
              style={styles.headerAction}
              testID="create-room"
            >
              <Text style={styles.headerActionText}>
                {showCreateChannel ? '✕ CLOSE' : `＋ ${ROOM_LABEL.toUpperCase()}`}
              </Text>
            </TouchableOpacity>
          )}
        </View>

        {showCreateChannel && !viewerIsAgent && (
          <PixelGateReveal style={styles.actionPanel}>
            <Text style={styles.panelTitle}>
              New {ROOM_LABEL} in {activeCommunity?.name ?? WORKSPACE_LABEL}
            </Text>
            <View style={styles.inlineForm}>
              <TextInput
                autoFocus
                style={styles.input}
                value={channelName}
                onChangeText={setChannelName}
                onSubmitEditing={() => void handleCreateChannel()}
                placeholder={`${ROOM_LABEL.toLowerCase()} name`}
                placeholderTextColor={theme.buzz.dim}
                editable={!creatingChannel}
              />
              <MonoButton
                disabled={!channelName.trim()}
                label={creatingChannel ? 'CREATING' : 'CREATE'}
                loading={creatingChannel}
                onPress={() => void handleCreateChannel()}
              />
            </View>
            <TouchableOpacity
              accessibilityRole="button"
              disabled={creatingChannel}
              onPress={() => void handleToggleRepoPicker()}
              style={styles.repoRow}
              testID="create-room-repo-row"
            >
              <Text style={styles.repoRowLabel}>REPO</Text>
              <Text numberOfLines={1} style={styles.repoRowValue}>
                {pendingRepo ? `▢ ${pendingRepo.name}` : 'none — chat only'}
              </Text>
              <Text style={styles.repoRowChevron}>{showRepoPicker ? '⌄' : '›'}</Text>
            </TouchableOpacity>
            {showRepoPicker && (
              <RepoPicker
                candidates={repoCandidates}
                installations={githubInstallations}
                currentKey={pendingRepo?.key ?? null}
                error={repoPickerError}
                notice={repoPickerNotice}
                onAddAccount={() => void handleAddGitHubAccount()}
                onCreateRepository={handleCreateGitHubRepository}
                onManageInstallation={(installation) =>
                  void handleManageGitHubInstallation(installation)
                }
                onSelect={handleSelectRepoCandidate}
                testIDPrefix="create-room-repo-picker"
              />
            )}
          </PixelGateReveal>
        )}

        {error && (
          <View accessibilityRole="alert" style={styles.errorPanel}>
            <Text style={styles.errorLabel}>! ERROR</Text>
            <Text accessibilityRole="alert" style={styles.errorText}>
              {error}
            </Text>
            <MonoButton
              label="RETRY"
              onPress={() => void handleRefresh(true)}
              style={styles.errorRetry}
              variant="secondary"
            />
          </View>
        )}

        <FlatList
          testID="room-list"
          data={roomFeed}
          keyExtractor={(entry) => entry.item.id}
          contentContainerStyle={hasConversations ? styles.listContent : styles.emptyContainer}
          ListEmptyComponent={
            !hasConversations ? (
              <View style={styles.emptyState}>
                <Text style={styles.emptyGlyph}>⌁</Text>
                <Text style={styles.emptyTitle}>No {ROOMS_LABEL.toLowerCase()} yet</Text>
                <Text style={styles.emptySubtitle}>
                  {activeCommunity
                    ? `A ${ROOM_LABEL} is where you and your Agents talk about the work. ` +
                      `${CHANGES_LABEL.charAt(0).toUpperCase()}${CHANGES_LABEL.slice(1)} branch off a ${ROOM_LABEL} for isolated edits, and only a person can land them.`
                    : `${WORKSPACE_LABEL} setup is still finishing.`}
                </Text>
                {!viewerIsAgent && !showCreateChannel && (
                  <MonoButton
                    label={`＋ ${ROOM_LABEL.toUpperCase()}`}
                    onPress={() => setShowCreateChannel(true)}
                    style={styles.emptyAction}
                  />
                )}
                <CommunityInviteEntry
                  community={activeCommunity}
                  creatingInvite={creatingInvite}
                  allowPeopleInvites={activeCommunityId !== personalWorkspaceId}
                  showManageAgents
                  onInvitePeople={() => void handleInvitePeople()}
                  onManageAgents={() =>
                    activeCommunityId &&
                    router.push(
                      `/buzz/members?communityId=${encodeURIComponent(activeCommunityId)}` as Href,
                    )
                  }
                />
              </View>
            ) : null
          }
          renderItem={({ item: entry }) => {
            // Destructure so the `in` check narrows the item itself.
            const { item, row } = entry;
            return 'peerName' in item
              ? renderDirectEntry({ item, row })
              : renderRoomEntry({ item, row });
          }}
          onRefresh={() => void handleRefresh(true)}
          refreshing={refreshing}
        />

        {/* The deck's footer: the brass compose control, opening the five
            existing start flows over this same supervision deck. */}
        <View style={[styles.deckFoot, { paddingBottom: 20 + insets.bottom }]}>
          {!viewerIsAgent && <RoomDeckComposeMenu onSelect={handleComposeAction} />}
        </View>

        <DirectMessagePickerSheet
          busyPubkey={messagingPubkey}
          members={cachedListEntry.workspaceMembers}
          onClose={() => setMemberPickerVisible(false)}
          onMessage={(member) => void handleStartDirectMessage(member)}
          visible={memberPickerVisible}
        />
      </View>
    </BuzzCommunityShell>
  );
}

/**
 * The index's one leading column. Every row on this screen — Room or DM —
 * hangs its copy off the same left edge, so the whole screen scans as a single
 * list even where the leading unit differs (a Room reports state with a glyph,
 * a DM reports identity with its faceted mark).
 */
const ROW_MARK_WIDTH = 30;
const ROW_GAP = 10;
const SCREEN_INSET = 16;
/**
 * The right gutter — the index's marginalia column, and the exact counterpart
 * of the transcript's timestamp margin. It is a normal in-flow flex column on
 * every row (never absolutely positioned over the row): an overlay cannot add
 * height, so a tall copy block plus an overlaid gutter is exactly how the
 * first ship of this deck painted rows over their neighbours. Reserving the
 * column in flow keeps one clean right edge AND lets every row grow to fit
 * whatever it carries.
 */
const ROW_GUTTER_WIDTH = 46;
/**
 * The row's MINIMUM height, not its height: every row must reserve this much
 * so the gutter can hold both of its marks — the age stamp on the name's line,
 * the corner count below it at a full 44pt touch target — but a row carrying
 * a wrapped preview line grows past it instead of overflowing into its
 * neighbour. A fixed `height` here was the overlap defect that sank the
 * first ship of this deck.
 */
const INDEX_ROW_HEIGHT = 72;
/** Drops the gutter's first mark onto the same optical line as the row name. */
const ROW_GUTTER_TOP = 14;

const styles = StyleSheet.create((theme) => {
  const groknight = theme.buzz;
  return {
    container: { flex: 1, minWidth: 0, backgroundColor: groknight.bgTerminal },
    center: { alignItems: 'center', justifyContent: 'center' },
    loadingText: {
      ...Typography.mono('semiBold'),
      marginTop: 12,
      color: groknight.textMuted,
      fontSize: 11,
      lineHeight: 15,
      letterSpacing: 0.8,
    },
    header: {
      minHeight: 56,
      paddingLeft: SCREEN_INSET,
      paddingRight: 6,
      paddingVertical: 6,
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: groknight.bgTerminal,
      borderBottomWidth: 1,
      borderBottomColor: groknight.border,
    },
    headerAction: {
      minWidth: 44,
      minHeight: 44,
      paddingHorizontal: 10,
      alignItems: 'center',
      justifyContent: 'center',
    },
    /* The Workspace name is the header's anchor; Members and ＋Room read as
     * quiet named affordances beside it, on the index label's own tier rather
     * than competing with the name for the top of the ladder. */
    headerActionText: {
      ...Typography.mono(),
      color: groknight.textMuted,
      fontSize: 10,
      lineHeight: 14,
      letterSpacing: 0.8,
    },
    actionPanel: {
      paddingHorizontal: SCREEN_INSET,
      paddingVertical: 14,
      borderBottomWidth: 1,
      borderBottomColor: groknight.border,
      backgroundColor: groknight.bgTerminal,
    },
    panelTitle: {
      ...Typography.default('semiBold'),
      marginBottom: 10,
      color: groknight.textPrimary,
      fontSize: 15,
    },
    inlineForm: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    repoRow: {
      marginTop: 10,
      minHeight: 40,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
    },
    repoRowLabel: {
      ...Typography.mono(),
      color: groknight.textMuted,
      fontSize: 11,
    },
    repoRowValue: {
      ...Typography.mono(),
      flex: 1,
      minWidth: 0,
      textAlign: 'right',
      color: groknight.textSecondary,
      fontSize: 12,
    },
    repoRowChevron: { ...Typography.default(), color: groknight.chrome, fontSize: 18 },
    input: {
      ...Typography.default(),
      flex: 1,
      minWidth: 0,
      minHeight: 46,
      paddingHorizontal: 10,
      paddingVertical: 8,
      borderRadius: 3,
      borderWidth: 1,
      borderColor: groknight.border,
      color: groknight.textPrimary,
      backgroundColor: groknight.bgBase,
      fontSize: 13,
    },
    /* A transient failure is a notice on the slab, not a panel laid over it: one
     * hairline, the `! ERROR` label, and its own retry button carry it. */
    errorPanel: {
      paddingHorizontal: SCREEN_INSET,
      paddingTop: 12,
      paddingBottom: 14,
      borderBottomWidth: 1,
      borderBottomColor: groknight.border,
    },
    errorLabel: {
      ...Typography.mono('semiBold'),
      color: groknight.textPrimary,
      fontSize: 10,
      lineHeight: 14,
      letterSpacing: 0.8,
    },
    errorText: {
      ...Typography.default(),
      marginTop: 4,
      color: groknight.textSecondary,
      fontSize: 12,
      lineHeight: 17,
    },
    errorRetry: { marginTop: 10, alignSelf: 'flex-start' },
    listContent: { paddingBottom: 24 },

    /* ── the index: one headerless feed of boxless rows ──────────────────── */
    /* The row is a self-sizing flex container: minHeight floor, never a fixed
     * height, and children top-aligned like the mockup's mark/title baseline.
     * The gutter is a sibling column IN FLOW (see ROW_GUTTER_WIDTH), so the
     * pressable needs no compensating right padding. */
    indexRow: {
      minWidth: 0,
      minHeight: INDEX_ROW_HEIGHT,
      paddingLeft: SCREEN_INSET,
      paddingRight: SCREEN_INSET,
      paddingVertical: groknight.name === 'ledger' ? 6 : 11,
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: ROW_GAP,
    },
    /* Fixed-width leading mark column — a flex child, not an overlay. Its box is
     * the exact height of the name's line and the mark is centered in it, so the
     * dot/ring/mark lands AT the name's height instead of floating above it. */
    rowMark: { width: ROW_MARK_WIDTH, height: 21, alignItems: 'center', justifyContent: 'center' },
    rowCopy: { flex: 1, minWidth: 0 },
    rowTitleLine: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
    /* The index reads on three tones and nothing else: the name is the brightest
     * thing on the row, the activity line sits a step down, and everything the
     * gutter carries is ghosted. It is the ledger's ladder at index scale, so a
     * row previews the voice the transcript will show when it is opened. */
    rowTitle: {
      ...Typography.default(),
      fontFamily: groknight.proseRegular,
      flexShrink: 1,
      color: groknight.textPrimary,
      fontSize: 16,
      lineHeight: 21,
    },
    rowTitleUnread: {
      ...Typography.default('semiBold'),
      fontFamily: groknight.proseSemibold,
    },
    rowTitleArchived: { color: groknight.textMuted },
    /* The repo name rides the title line's right edge — mono micro-metadata,
     * exactly what the mockup hangs there; never a second row of its own. */
    rowRepo: {
      ...Typography.mono(),
      marginLeft: 'auto',
      flexShrink: 0,
      color: groknight.textMuted,
      fontSize: 10,
      lineHeight: 13,
      letterSpacing: 0.3,
    },
    rowFlag: {
      ...Typography.mono('semiBold'),
      color: groknight.textMuted,
      fontSize: 9,
      lineHeight: 12,
      letterSpacing: 0.8,
    },
    /* Always rendered, even when a Room has no timestamp to show, so the mark
     * below it in the gutter never shifts up a line. */
    rowAge: {
      ...Typography.mono(),
      minHeight: 14,
      color: groknight.ledgerGhost,
      fontSize: 10,
      lineHeight: 14,
      letterSpacing: 0.4,
    },
    /* The current fact sits one tone below the Room name — except on a needs-you
     * row, where it takes the accent: the one place brass speaks on this screen. */
    rowPreview: {
      ...Typography.default(),
      fontFamily: groknight.proseRegular,
      marginTop: 3,
      color: groknight.ledgerQuiet,
      fontSize: groknight.name === 'ledger' ? 11 : 13,
      lineHeight: groknight.name === 'ledger' ? 15 : 18,
    },
    roomCell: {
      position: 'relative',
      borderBottomWidth: 1,
      borderBottomColor: groknight.border,
    },
    roomRow: { position: 'relative', minWidth: 0, flexDirection: 'row', alignItems: 'stretch' },
    roomPrimary: { flex: 1, minWidth: 0 },
    /* Marginalia, not a third column of content: a fixed-width, right-aligned
     * IN-FLOW column, and every mark in it ghosted — the same treatment the
     * transcript gives its timestamps and npub fingerprints. In flow (never
     * absolute) so it can never paint over the neighbouring row, and so a tall
     * gutter grows its own row instead of escaping it. */
    rowGutter: {
      width: ROW_GUTTER_WIDTH,
      flexShrink: 0,
      marginRight: SCREEN_INSET,
      flexDirection: 'column',
      alignItems: 'flex-end',
      paddingTop: ROW_GUTTER_TOP,
    },
    cornerPeek: {
      width: ROW_GUTTER_WIDTH,
      minHeight: 44,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'flex-end',
    },
    cornerPeekCount: {
      ...Typography.mono(),
      color: groknight.ledgerGhost,
      fontSize: 12,
      lineHeight: 15,
    },
    cornerPeekChevron: {
      ...Typography.mono(),
      color: groknight.ledgerGhost,
      fontSize: 10,
      lineHeight: 13,
    },
    /* ── expanded corners: a hairline rail, not a nested container ────────── */
    cornerDropdown: {
      position: 'relative',
      paddingLeft: SCREEN_INSET + ROW_MARK_WIDTH + ROW_GAP,
      paddingRight: SCREEN_INSET,
      paddingBottom: 8,
    },
    cornerRail: {
      position: 'absolute',
      top: 0,
      bottom: 18,
      left: SCREEN_INSET + ROW_MARK_WIDTH / 2,
      width: 1,
      backgroundColor: groknight.border,
    },
    cornerRow: {
      minHeight: 44,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
    },
    cornerGlyph: {
      width: 14,
      height: 14,
      flexShrink: 0,
    },
    cornerName: {
      ...Typography.default(),
      flex: 1,
      minWidth: 0,
      color: groknight.textPrimary,
      fontSize: 13,
      lineHeight: 17,
    },
    /* ── the deck's footer: one brass ＋ ───────────────────── */
    deckFoot: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'flex-end',
      paddingHorizontal: SCREEN_INSET,
      paddingTop: 12,
      borderTopWidth: 1,
      borderTopColor: groknight.border,
      backgroundColor: groknight.bgTerminal,
    },
    /* ── empty state ─────────────────────────────────────────────────────── */
    emptyContainer: { flexGrow: 1 },
    emptyState: { flex: 1, paddingHorizontal: 26, alignItems: 'center', justifyContent: 'center' },
    emptyGlyph: {
      ...Typography.default(),
      color: groknight.steel,
      fontSize: 30,
      lineHeight: 36,
      textAlign: 'center',
    },
    emptyTitle: {
      ...Typography.default('semiBold'),
      marginTop: 14,
      color: groknight.textPrimary,
      fontSize: 17,
      textAlign: 'center',
    },
    emptySubtitle: {
      ...Typography.default(),
      marginTop: 8,
      color: groknight.textMuted,
      fontSize: 12,
      lineHeight: 19,
      textAlign: 'center',
    },
    emptyAction: { marginTop: 20 },
  };
});
