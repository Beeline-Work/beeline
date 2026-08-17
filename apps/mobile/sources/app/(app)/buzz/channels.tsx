import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FlatList,
  Share,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
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
} from '@beeline/buzz-client';
import {
  DEFAULT_RELAY_URL,
  getEffectiveRelayUrl,
  loadBuzzIdentity,
} from '@/auth/buzz-identity-storage';
import { groknight } from '@/buzz/groknight';
import { saveLastViewedChannel } from '@/buzz/community-storage';
import { createCommunityInviteUrl } from '@/buzz/community-invite';
import { prepareWorkspaceContext } from '@/buzz/workspace-bootstrap';
import { isWorkspaceManagerRole } from '@/buzz/workspace-role';
import { roomParticipantPubkeys } from '@/buzz/room-participants';
import { shortMemberNpub } from '@/buzz/member-display';
import { ensurePersonNameForWorkspace } from '@/buzz/person-name';
import { resolveAgentDisplayIdentity } from '@/buzz/agent-display';
import { compactRelativeTime } from '@/buzz/relative-time';
import { previewAuthorLabel } from '@/buzz/room-list-summary';
import { isRoomUnread, roomReadAt, useRoomReadState } from '@/buzz/room-read-state';
import {
  cornerStatusPresentation,
  isCornerActive,
  roomCornerSignal,
  roomListCorners,
  sortCorners,
  type CornerSummary,
} from '@/buzz/corners';
import {
  CHANGES_LABEL,
  CORNER_LABEL,
  ROOM_LABEL,
  ROOMS_LABEL,
  WORKSPACE_LABEL,
} from '@/buzz/vocabulary';
import { CommunityInviteEntry } from '@/components/buzz/CommunityInviteEntry';
import { AgentAvatar } from '@/components/buzz/AgentAvatar';
import { PersonAvatar } from '@/components/buzz/PersonAvatar';
import { BuzzCommunityShell, CommunityDrawerTrigger } from '@/components/buzz/CommunityRail';
import { BuzzRigTransport } from '@/sync/transport';
import { Typography } from '@/constants/Typography';
import {
  selectChannelList,
  channelListCacheKey,
  mergeChannelBasicsWithCache,
  setActiveBuzzCacheViewer,
  useBuzzLocalCache,
  type ChannelDisplayItem,
  type DirectMessageDisplayItem,
  type WorkspaceMemberDisplayItem,
} from '@/buzz/local-cache';
import { cacheLiveSessionEvent, revalidateCachedMessages } from '@/buzz/local-cache-sync';
import {
  BrittlePress,
  hairlineDivider,
  HullSurface,
  HullWaveSignal,
  MonoButton,
  PixelGateReveal,
  PixelLoader,
} from '@/components/buzz/MonoHull';

/** Relative ages only change on the minute, so the index re-derives them on a
 * one-minute tick while it is the focused screen and never on a render loop. */
const AGE_TICK_MS = 60_000;

/** The one row-leading glyph vocabulary of the index: corner state when a Room
 * has reportable corner work, otherwise whether the Room has been spoken in.
 * `cornerStatusPresentation` stays the single source for the corner glyphs. */
function roomRowGlyph(signal: ReturnType<typeof roomCornerSignal>, hasMessage: boolean): string {
  if (signal) return cornerStatusPresentation(signal).glyph;
  return hasMessage ? '›' : '·';
}

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
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
    return rooms
      .filter((room) => !room.archived)
      .sort((a, b) => (b.updatedAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.createdAt ?? 0));
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
  return resolved.filter((item) => !item.parentChannelId && !item.archived);
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
  const enriched = await Promise.all(
    rooms.map(async (room): Promise<ChannelDisplayItem> => {
      const [synced, members] = await Promise.allSettled([
        revalidateCachedMessages(transport, viewerPubkey, room.id),
        client.listMembers(room.id),
      ]);
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
            ? roomParticipantPubkeys(
                new Set(members.value.map((member) => member.pubkey)),
                workspacePeople,
                workspaceAgents,
              ).size
            : 0,
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
  const [channelName, setChannelName] = useState('');
  const [creatingChannel, setCreatingChannel] = useState(false);
  const [viewerIsAgent, setViewerIsAgent] = useState(initialListCache?.viewerIsAgent ?? false);
  const [viewerAvatarUrl, setViewerAvatarUrl] = useState<string | undefined>(
    initialListCache?.viewerAvatarUrl,
  );
  const [canEditWorkspaceAvatar, setCanEditWorkspaceAvatar] = useState(
    initialListCache?.canEditWorkspaceAvatar ?? false,
  );
  const [creatingInvite, setCreatingInvite] = useState(false);
  const [readyInviteUrl, setReadyInviteUrl] = useState<string | undefined>(inviteUrl);
  const [expandedRoomId, setExpandedRoomId] = useState<string | null>(null);
  const [ageNow, setAgeNow] = useState(() => Date.now());
  const skipInitialFocusRefresh = useRef(true);
  const loadGeneration = useRef(0);
  const visibleRefreshGeneration = useRef<number | null>(null);
  const readAt = useRoomReadState((state) => state.readAt);
  const markRoomRead = useRoomReadState((state) => state.markRoomRead);
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
    () => displayChannels.map((channel) => channel.id).sort().join(','),
    [displayChannels],
  );
  const orderedChannels = useMemo(
    () =>
      [...displayChannels].sort((a, b) => {
        const aActive = a.corners?.some((corner) => isCornerActive(corner.status)) ? 1 : 0;
        const bActive = b.corners?.some((corner) => isCornerActive(corner.status)) ? 1 : 0;
        return (
          bActive - aActive ||
          (b.updatedAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.createdAt ?? 0) ||
          (a.title ?? a.id).localeCompare(b.title ?? b.id)
        );
      }),
    [displayChannels],
  );
  const orderedDirectMessages = useMemo(
    () =>
      [...directMessages].sort(
        (a, b) => b.updatedAt - a.updatedAt || a.peerName.localeCompare(b.peerName),
      ),
    [directMessages],
  );
  const hasConversations = orderedChannels.length > 0 || orderedDirectMessages.length > 0;
  const liveRoomCount = orderedChannels.filter((channel) =>
    roomCornerSignal(channel.corners ?? []),
  ).length;

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
        const [workspaceContext, identityIsAgent] = await Promise.all([
          prepareWorkspaceContext(client, currentIdentity.publicKey, requestedCommunity),
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
  useFocusEffect(
    useCallback(() => {
      if (!transport || !identity) return;
      if (skipInitialFocusRefresh.current) {
        skipInitialFocusRefresh.current = false;
        return;
      }
      void handleRefresh(false);
    }, [handleRefresh, identity, transport]),
  );

  // Room previews are a live projection, not a creation-time cache field.
  // Keep the list current while it is visible; cacheLiveSessionEvent also
  // writes the same fresh summary to MMKV on the next background transition.
  useFocusEffect(
    useCallback(() => {
      if (!transport || !identity || !roomIdsKey) return;
      const unsubscribes = roomIdsKey.split(',').map((channelId) =>
        transport.sessionEventsSubscribe(channelId, (event) => {
          cacheLiveSessionEvent(identity.publicKey, channelId, event);
        }),
      );
      return () => unsubscribes.forEach((unsubscribe) => unsubscribe());
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
      setChannelName('');
      setShowCreateChannel(false);
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
  }, [activeCommunityId, channelName, communities, identity, transport, viewerIsAgent]);

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
      onSettings={() => router.push('/buzz/settings/identity' as Href)}
      onWorkspaceSettings={(communityId) =>
        router.push(
          { pathname: '/buzz/settings/workspace', params: { communityId } } as unknown as Href,
        )
      }
      canManageActiveCommunity={canEditWorkspaceAvatar}
      viewerPubkey={identity?.publicKey}
      viewerAvatarUrl={viewerAvatarUrl}
    >
      <View style={[styles.container, { paddingTop: insets.top }]}>
        <HullSurface strength="quiet" style={styles.header}>
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
              <Text style={styles.headerActionText}>PEOPLE</Text>
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
        </HullSurface>

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
                placeholderTextColor={groknight.dim}
                editable={!creatingChannel}
              />
              <MonoButton
                disabled={!channelName.trim()}
                label={creatingChannel ? 'CREATING' : 'CREATE'}
                loading={creatingChannel}
                onPress={() => void handleCreateChannel()}
              />
            </View>
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
          data={orderedChannels}
          keyExtractor={(item) => item.id}
          contentContainerStyle={hasConversations ? styles.listContent : styles.emptyContainer}
          ListHeaderComponent={
            orderedChannels.length > 0 ? (
              <View style={styles.indexHeader}>
                <Text style={styles.indexLabel}>
                  {ROOMS_LABEL.toUpperCase()} · {orderedChannels.length}
                </Text>
                {liveRoomCount > 0 && (
                  <View style={styles.indexSignal}>
                    <HullWaveSignal compact label="LIVE" />
                    <Text style={styles.indexSignalCount}>{liveRoomCount}</Text>
                  </View>
                )}
              </View>
            ) : null
          }
          ListFooterComponent={
            orderedDirectMessages.length > 0 ? (
              <View style={styles.dmSection}>
                <View style={styles.indexHeader}>
                  <Text style={styles.indexLabel}>
                    DIRECT · {orderedDirectMessages.length}
                  </Text>
                </View>
                {orderedDirectMessages.map((dm) => {
                  const display = dm.peerAgent
                    ? resolveAgentDisplayIdentity(dm.peerPubkey, dm.peerAgent)
                    : undefined;
                  const unread = isRoomUnread(
                    roomReadAt(readAt, identity?.publicKey, dm.id),
                    dm.latestMessageAt,
                  );
                  const age = compactRelativeTime(dm.latestMessageAt ?? dm.updatedAt, ageNow);
                  return (
                    <TouchableOpacity
                      accessibilityLabel={`Open direct message with ${dm.peerName}${
                        unread ? ', unread' : ''
                      }`}
                      key={dm.id}
                      onPress={() => openChannel(dm.id)}
                      style={[styles.indexRow, styles.rowTrailingReserve]}
                      testID={`direct-message-${dm.peerPubkey}`}
                    >
                      <View style={styles.rowMark}>
                        {display ? (
                          <AgentAvatar
                            pubkey={dm.peerPubkey}
                            avatarSeed={display.avatarSeed}
                            avatarUrl={display.avatarUrl}
                            name={display.name}
                            size={30}
                          />
                        ) : (
                          <PersonAvatar
                            pubkey={dm.peerPubkey}
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
                          {unread && <Text style={styles.rowUnread}>NEW</Text>}
                          {age !== '' && (
                            <Text style={[styles.rowAge, unread && styles.rowAgeUnread]}>{age}</Text>
                          )}
                        </View>
                        <Text
                          numberOfLines={1}
                          style={[styles.rowPreview, unread && styles.rowPreviewUnread]}
                        >
                          {dm.latestMessage ?? 'Nothing said yet'}
                        </Text>
                      </View>
                    </TouchableOpacity>
                  );
                })}
              </View>
            ) : null
          }
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
          renderItem={({ item }) => {
            const corners = roomListCorners(item.corners ?? []);
            const cornerSignal = roomCornerSignal(item.corners ?? []);
            const canExpand = corners.length > 0;
            const title = item.title ?? `${ROOM_LABEL.toLowerCase()} ${item.id.slice(0, 8)}`;
            const expanded = canExpand && expandedRoomId === item.id;
            const unread = isRoomUnread(
              roomReadAt(readAt, identity?.publicKey, item.id),
              item.latestMessageAt,
            );
            const author = previewAuthorLabel(
              item.latestMessageAuthor ? authorNames.get(item.latestMessageAuthor) : undefined,
            );
            const age = compactRelativeTime(item.latestMessageAt ?? item.updatedAt, ageNow);
            return (
              <View style={styles.roomCell}>
                <View style={styles.roomRow}>
                  <BrittlePress
                    accessibilityHint={
                      canExpand ? `Long press to reveal ${CORNER_LABEL.toLowerCase()}s` : undefined
                    }
                    accessibilityLabel={`Open ${title}${unread ? ', unread' : ''}, ${
                      item.participantCount ?? 0
                    } participants${canExpand ? `, ${corners.length} open ${CHANGES_LABEL}` : ''}`}
                    contentStyle={
                      canExpand ? styles.indexRow : [styles.indexRow, styles.rowTrailingReserve]
                    }
                    delayLongPress={350}
                    onLongPress={
                      canExpand
                        ? () =>
                            setExpandedRoomId((current) => (current === item.id ? null : item.id))
                        : undefined
                    }
                    onPress={() => openChannel(item.id)}
                    style={styles.roomPrimary}
                    testID={`room-${item.id}`}
                  >
                    <View style={styles.rowMark}>
                      <Text
                        style={[
                          styles.roomGlyph,
                          cornerSignal === 'needs-attention' && styles.roomGlyphAttention,
                          cornerSignal === 'live' && styles.roomGlyphLive,
                        ]}
                      >
                        {roomRowGlyph(cornerSignal, Boolean(item.latestMessage))}
                      </Text>
                    </View>
                    <View style={styles.rowCopy}>
                      <View style={styles.rowTitleLine}>
                        <Text
                          numberOfLines={1}
                          style={[
                            styles.rowTitle,
                            unread && styles.rowTitleUnread,
                            item.archived && styles.rowTitleArchived,
                          ]}
                        >
                          {title}
                        </Text>
                        {item.archived && <Text style={styles.rowFlag}>ARCHIVED</Text>}
                        {unread && <Text style={styles.rowUnread}>NEW</Text>}
                        {age !== '' && (
                          <Text style={[styles.rowAge, unread && styles.rowAgeUnread]}>{age}</Text>
                        )}
                      </View>
                      <Text
                        numberOfLines={1}
                        style={[styles.rowPreview, unread && styles.rowPreviewUnread]}
                      >
                        {author !== '' && <Text style={styles.rowPreviewAuthor}>{author} </Text>}
                        {item.latestMessage ?? 'Nothing said yet'}
                      </Text>
                    </View>
                  </BrittlePress>
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
                      <Text style={styles.cornerPeekCount}>{corners.length}</Text>
                      <Text style={styles.cornerPeekCaret}>{expanded ? '⌃' : '⌄'}</Text>
                    </TouchableOpacity>
                  )}
                </View>
                {expanded && (
                  <PixelGateReveal style={styles.cornerDropdown}>
                    <View style={styles.cornerRail} />
                    {corners.map((corner) => {
                      const status = cornerStatusPresentation(corner.status);
                      return (
                        <TouchableOpacity
                          accessibilityLabel={`Open ${corner.name} ${CORNER_LABEL}, ${status.label}`}
                          key={corner.id}
                          onPress={() =>
                            router.push(`/buzz/chat/${encodeURIComponent(corner.id)}` as Href)
                          }
                          style={styles.cornerRow}
                        >
                          <Text
                            style={[
                              styles.cornerGlyph,
                              corner.status === 'live' && styles.cornerGlyphLive,
                            ]}
                          >
                            {status.glyph}
                          </Text>
                          <Text numberOfLines={1} style={styles.cornerName}>
                            {corner.name}
                          </Text>
                          <Text style={styles.cornerStatus}>{status.label}</Text>
                        </TouchableOpacity>
                      );
                    })}
                    <TouchableOpacity
                      accessibilityLabel={`All ${CHANGES_LABEL} in ${title}`}
                      accessibilityRole="button"
                      onPress={() =>
                        router.push(`/buzz/corners/${encodeURIComponent(item.id)}` as Href)
                      }
                      style={styles.cornerRow}
                      testID={`room-all-corners-${item.id}`}
                    >
                      <Text style={styles.cornerAllText}>ALL {CHANGES_LABEL.toUpperCase()}</Text>
                      <Text style={styles.cornerAllCaret}>›</Text>
                    </TouchableOpacity>
                  </PixelGateReveal>
                )}
              </View>
            );
          }}
          onRefresh={() => void handleRefresh(true)}
          refreshing={refreshing}
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
 * The trailing disclosure column, reserved on *every* row whether or not it has
 * corners. Letting the column collapse on a corner-less row moved that row's
 * age stamp 46px right of its neighbours', which ragged the one right edge the
 * index reads down.
 */
const ROW_TRAILING_WIDTH = 46;

const styles = StyleSheet.create({
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
    backgroundColor: groknight.bgBase,
    ...hairlineDivider,
  },
  headerAction: {
    minWidth: 44,
    minHeight: 44,
    paddingHorizontal: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerActionText: {
    ...Typography.mono('semiBold'),
    color: groknight.textSecondary,
    fontSize: 10,
    lineHeight: 14,
    letterSpacing: 0.8,
  },
  actionPanel: {
    paddingHorizontal: SCREEN_INSET,
    paddingVertical: 14,
    ...hairlineDivider,
    backgroundColor: groknight.bgTerminal,
  },
  panelTitle: {
    ...Typography.default('semiBold'),
    marginBottom: 10,
    color: groknight.textPrimary,
    fontSize: 15,
  },
  inlineForm: { flexDirection: 'row', alignItems: 'center', gap: 8 },
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
  errorPanel: {
    marginHorizontal: SCREEN_INSET,
    marginTop: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 3,
    borderWidth: 1,
    borderColor: groknight.borderStrong,
    backgroundColor: groknight.bgRaised,
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

  /* ── the index: manifest headings, then boxless rows ─────────────────── */
  indexHeader: {
    minHeight: 34,
    paddingHorizontal: SCREEN_INSET,
    paddingTop: 14,
    paddingBottom: 6,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  indexLabel: {
    ...Typography.mono('semiBold'),
    color: groknight.textMuted,
    fontSize: 10,
    lineHeight: 14,
    letterSpacing: 1.1,
  },
  indexSignal: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  indexSignalCount: {
    ...Typography.mono('semiBold'),
    color: groknight.accent,
    fontSize: 11,
    lineHeight: 15,
  },
  dmSection: { marginTop: 4 },
  indexRow: {
    minWidth: 0,
    minHeight: 62,
    paddingHorizontal: SCREEN_INSET,
    paddingVertical: 11,
    flexDirection: 'row',
    alignItems: 'center',
    gap: ROW_GAP,
  },
  rowMark: { width: ROW_MARK_WIDTH, alignItems: 'center', justifyContent: 'center' },
  rowTrailingReserve: { paddingRight: SCREEN_INSET + ROW_TRAILING_WIDTH },
  rowCopy: { flex: 1, minWidth: 0 },
  rowTitleLine: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  rowTitle: {
    ...Typography.default('semiBold'),
    flexShrink: 1,
    color: groknight.textSecondary,
    fontSize: 15,
    lineHeight: 20,
  },
  /* Unread is weight plus one luminance step, in two places (the name and its
   * age) plus a named mono flag — never gold. DESIGN.md fixes gold to agent
   * identity, live presence, owner role, and merge approval; unread would be a
   * fifth meaning with nothing to stay redundant against. */
  rowTitleUnread: { color: groknight.textPrimary },
  rowTitleArchived: { color: groknight.textMuted },
  rowUnread: {
    ...Typography.mono('semiBold'),
    color: groknight.textPrimary,
    fontSize: 9,
    lineHeight: 12,
    letterSpacing: 0.8,
  },
  rowFlag: {
    ...Typography.mono('semiBold'),
    color: groknight.textMuted,
    fontSize: 9,
    lineHeight: 12,
    letterSpacing: 0.8,
  },
  rowAge: {
    ...Typography.mono(),
    marginLeft: 'auto',
    color: groknight.textDisabled,
    fontSize: 10,
    lineHeight: 14,
  },
  rowAgeUnread: { ...Typography.mono('semiBold'), color: groknight.textSecondary },
  rowPreview: {
    ...Typography.default(),
    marginTop: 3,
    color: groknight.textMuted,
    fontSize: 12,
    lineHeight: 16,
  },
  rowPreviewUnread: { color: groknight.textSecondary },
  rowPreviewAuthor: {
    ...Typography.mono('semiBold'),
    color: groknight.steel,
    fontSize: 10,
    lineHeight: 16,
    letterSpacing: 0.5,
  },
  roomCell: { ...hairlineDivider, backgroundColor: groknight.bgTerminal },
  roomRow: { minWidth: 0, flexDirection: 'row', alignItems: 'stretch' },
  roomPrimary: { flex: 1, minWidth: 0 },
  roomGlyph: {
    ...Typography.default('semiBold'),
    color: groknight.steel,
    fontSize: 15,
    lineHeight: 20,
    textAlign: 'center',
  },
  /* The one accent on this screen, and only for genuinely live corner work —
   * redundant with the ◆ glyph it colors and with the LIVE wave in the heading. */
  roomGlyphLive: { color: groknight.accent },
  /* Attention is the most action-worthy state here, so it takes the brightest
   * gray rather than gold — gold stays exclusive to live work. */
  roomGlyphAttention: { color: groknight.textPrimary },
  cornerPeek: {
    width: ROW_TRAILING_WIDTH,
    minHeight: 62,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cornerPeekCount: {
    ...Typography.mono('semiBold'),
    color: groknight.textSecondary,
    fontSize: 12,
    lineHeight: 14,
  },
  /* Count and caret read as one disclosure control, so the caret carries real
   * weight instead of trailing off as a stray mark under a number. */
  cornerPeekCaret: {
    ...Typography.default('semiBold'),
    color: groknight.textSecondary,
    fontSize: 15,
    lineHeight: 15,
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
    ...Typography.default('semiBold'),
    width: 12,
    color: groknight.steel,
    fontSize: 11,
    lineHeight: 15,
  },
  cornerGlyphLive: { color: groknight.accent },
  cornerName: {
    ...Typography.default('semiBold'),
    flex: 1,
    minWidth: 0,
    color: groknight.textSecondary,
    fontSize: 13,
    lineHeight: 17,
  },
  cornerStatus: {
    ...Typography.mono('semiBold'),
    color: groknight.textMuted,
    fontSize: 9,
    lineHeight: 12,
    letterSpacing: 0.6,
  },
  cornerAllText: {
    ...Typography.mono('semiBold'),
    flex: 1,
    minWidth: 0,
    marginLeft: 20,
    color: groknight.textMuted,
    fontSize: 9,
    lineHeight: 12,
    letterSpacing: 0.8,
  },
  cornerAllCaret: {
    ...Typography.default('semiBold'),
    color: groknight.steel,
    fontSize: 14,
    lineHeight: 16,
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
});
