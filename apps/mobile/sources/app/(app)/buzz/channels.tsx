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
import { roomParticipantPubkeys } from '@/buzz/room-participants';
import { shortMemberNpub } from '@/buzz/member-display';
import { ensurePersonNameForWorkspace } from '@/buzz/person-name';
import { resolveAgentDisplayIdentity } from '@/buzz/agent-display';
import {
  cornerStatusPresentation,
  isCornerActive,
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
  PixelGateReveal,
  PixelLoader,
} from '@/components/buzz/MonoHull';

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
    canEditAvatar: viewerRole === 'owner' || viewerRole === 'admin',
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
  const skipInitialFocusRefresh = useRef(true);
  const loadGeneration = useRef(0);
  const visibleRefreshGeneration = useRef<number | null>(null);
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

  const activeCommunity = useMemo(
    () => communities.find((community) => community.communityId === activeCommunityId) ?? null,
    [communities, activeCommunityId],
  );

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

  const handleRoomPress = useCallback(
    (channel: ChannelDisplayItem) => {
      if (identity) {
        void saveLastViewedChannel(identity.publicKey, activeCommunityId, channel.id);
      }
      router.push(`/buzz/chat/${encodeURIComponent(channel.id)}` as Href);
    },
    [activeCommunityId, identity],
  );

  const handleDirectMessagePress = useCallback(
    (channelId: string) => {
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
          <View style={styles.headerIdentity}>
            <Text style={styles.headerTitle} numberOfLines={1}>
              {activeCommunity?.name ?? WORKSPACE_LABEL}
            </Text>
          </View>
          <View style={styles.headerActions}>
            {activeCommunityId && (
              <TouchableOpacity
                accessibilityLabel={`${WORKSPACE_LABEL} members`}
                onPress={() =>
                  router.push(
                    `/buzz/members?communityId=${encodeURIComponent(activeCommunityId)}` as Href,
                  )
                }
                style={styles.iconButton}
                testID="workspace-members"
              >
                <Text style={styles.iconButtonText}>◇</Text>
              </TouchableOpacity>
            )}
            {!viewerIsAgent && (
              <TouchableOpacity
                accessibilityLabel={`Create ${ROOM_LABEL}`}
                onPress={() => setShowCreateChannel((value) => !value)}
                style={styles.iconButton}
              >
                <Text style={styles.iconButtonText}>＋</Text>
              </TouchableOpacity>
            )}
          </View>
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
              <TouchableOpacity
                style={[styles.primarySmallButton, !channelName.trim() && styles.disabled]}
                disabled={!channelName.trim() || creatingChannel}
                onPress={() => void handleCreateChannel()}
              >
                <Text style={styles.primarySmallButtonText}>
                  {creatingChannel ? 'Creating…' : `Create ${ROOM_LABEL}`}
                </Text>
              </TouchableOpacity>
            </View>
          </PixelGateReveal>
        )}

        {error && (
          <View accessibilityRole="alert" style={styles.errorPanel}>
            <Text style={styles.errorLabel}>! ERROR</Text>
            <Text accessibilityRole="alert" style={styles.errorText}>
              {error}
            </Text>
            <TouchableOpacity onPress={() => void handleRefresh(true)}>
              <Text style={styles.retryText}>Retry</Text>
            </TouchableOpacity>
          </View>
        )}

        <FlatList
          testID="room-list"
          data={orderedChannels}
          keyExtractor={(item) => item.id}
          contentContainerStyle={hasConversations ? styles.listContent : styles.emptyContainer}
          ListHeaderComponent={
            orderedChannels.length > 0 ? (
              <View style={styles.sectionHeading}>
                <Text style={styles.sectionTitle}>{ROOMS_LABEL}</Text>
                <Text style={styles.dmSectionCount}>{orderedChannels.length}</Text>
              </View>
            ) : null
          }
          ListFooterComponent={
            orderedDirectMessages.length > 0 ? (
              <View style={styles.dmSection}>
                <View style={styles.sectionHeading}>
                  <Text style={styles.sectionTitle}>Direct messages</Text>
                  <Text style={styles.dmSectionCount}>{orderedDirectMessages.length}</Text>
                </View>
                {orderedDirectMessages.map((dm) => {
                  const display = dm.peerAgent
                    ? resolveAgentDisplayIdentity(dm.peerPubkey, dm.peerAgent)
                    : undefined;
                  return (
                    <TouchableOpacity
                      accessibilityLabel={`Open direct message with ${dm.peerName}`}
                      key={dm.id}
                      onPress={() => handleDirectMessagePress(dm.id)}
                      style={styles.dmRow}
                      testID={`direct-message-${dm.peerPubkey}`}
                    >
                      {display ? (
                        <AgentAvatar
                          pubkey={dm.peerPubkey}
                          avatarSeed={display.avatarSeed}
                          avatarUrl={display.avatarUrl}
                          name={display.name}
                          size={38}
                        />
                      ) : (
                        <PersonAvatar
                          pubkey={dm.peerPubkey}
                          avatarUrl={dm.avatarUrl}
                          name={dm.peerName}
                          size={38}
                        />
                      )}
                      <View style={styles.dmCopy}>
                        <Text numberOfLines={1} style={styles.dmName}>
                          {dm.peerName}
                        </Text>
                        <Text numberOfLines={1} style={styles.latestMessage}>
                          {dm.latestMessage ?? 'No messages yet'}
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
                    ? `Start a focused place for steering and review.`
                    : `${WORKSPACE_LABEL} setup is still finishing.`}
                </Text>
                {!viewerIsAgent && !showCreateChannel && (
                  <TouchableOpacity
                    style={styles.primaryButton}
                    onPress={() => setShowCreateChannel(true)}
                  >
                    <Text style={styles.primaryButtonText}>New {ROOM_LABEL.toLowerCase()}</Text>
                  </TouchableOpacity>
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
            const canExpand = corners.length > 0;
            const hasLiveCorner = corners.some((corner) => isCornerActive(corner.status));
            const title = item.title ?? `${ROOM_LABEL.toLowerCase()} ${item.id.slice(0, 8)}`;
            const expanded = canExpand && expandedRoomId === item.id;
            return (
              <View style={[styles.roomCell, expanded && styles.roomCellExpanded]}>
                <View style={styles.roomRow}>
                  <BrittlePress
                    accessibilityHint={
                      canExpand ? `Long press to reveal ${CORNER_LABEL.toLowerCase()}s` : undefined
                    }
                    accessibilityLabel={`Open ${title} chat`}
                    contentStyle={styles.channelItem}
                    delayLongPress={350}
                    onLongPress={
                      canExpand
                        ? () =>
                            setExpandedRoomId((current) => (current === item.id ? null : item.id))
                        : undefined
                    }
                    onPress={() => void handleRoomPress(item)}
                    style={styles.roomPrimary}
                    testID={`room-${item.id}`}
                  >
                    <View style={styles.channelInfo}>
                      <View style={styles.channelTitleRow}>
                        <Text
                          numberOfLines={1}
                          style={[styles.channelTitle, item.archived && styles.archivedTitle]}
                        >
                          {title}
                        </Text>
                        {item.archived && <Text style={styles.metaTag}>archived</Text>}
                      </View>
                      <View style={styles.roomMetaRow}>
                        <Text numberOfLines={1} style={styles.latestMessage}>
                          {item.latestMessage ?? 'No messages yet'}
                        </Text>
                        <Text style={styles.participantCount}>◇ {item.participantCount ?? 0}</Text>
                      </View>
                    </View>
                  </BrittlePress>
                  {canExpand && (
                    <TouchableOpacity
                      accessibilityLabel={`${expanded ? 'Hide' : 'Show'} ${corners.length} ${
                        corners.length === 1 ? CORNER_LABEL : CHANGES_LABEL
                      } in ${title}${hasLiveCorner ? ', live corner present' : ''}`}
                      accessibilityRole="button"
                      accessibilityState={{ expanded }}
                      onPress={() =>
                        setExpandedRoomId((current) => (current === item.id ? null : item.id))
                      }
                      style={styles.cornerPeekButton}
                      testID={`room-corners-toggle-${item.id}`}
                    >
                      <Text style={[styles.cornerPeekCount, hasLiveCorner && styles.liveMarker]}>
                        {hasLiveCorner ? '◆' : '◇'} {corners.length}
                      </Text>
                      <Text style={styles.cornerPeekChevron}>{expanded ? '⌃' : '⌄'}</Text>
                    </TouchableOpacity>
                  )}
                </View>
                {expanded && (
                  <PixelGateReveal style={styles.cornerDropdown}>
                    {corners.map((corner) => {
                      const status = cornerStatusPresentation(corner.status);
                      return (
                        <TouchableOpacity
                          accessibilityLabel={`Open #${corner.name}, ${status.label}`}
                          key={corner.id}
                          onPress={() =>
                            router.push(`/buzz/chat/${encodeURIComponent(corner.id)}` as Href)
                          }
                          style={styles.cornerRow}
                        >
                          <Text numberOfLines={1} style={styles.cornerName}>
                            └ #{corner.name}
                          </Text>
                          <Text style={styles.cornerStatus}>
                            {status.glyph} {status.label}
                          </Text>
                        </TouchableOpacity>
                      );
                    })}
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
    minHeight: 58,
    paddingHorizontal: 12,
    paddingVertical: 7,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: groknight.bgBase,
    ...hairlineDivider,
  },
  headerIdentity: { flex: 1, minWidth: 0 },
  headerTitle: {
    ...Typography.default('semiBold'),
    color: groknight.textPrimary,
    fontSize: 20,
    lineHeight: 24,
  },
  headerActions: { flexDirection: 'row', gap: 2, marginLeft: 8 },
  iconButton: {
    minWidth: 44,
    height: 44,
    paddingHorizontal: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconButtonText: { ...Typography.default(), color: groknight.steel, fontSize: 17 },
  actionPanel: {
    paddingHorizontal: 16,
    paddingVertical: 16,
    ...hairlineDivider,
    backgroundColor: groknight.bgTerminal,
  },
  panelTitle: {
    ...Typography.default('semiBold'),
    marginBottom: 9,
    color: groknight.textPrimary,
    fontSize: 15,
  },
  inlineForm: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  input: {
    ...Typography.default(),
    flex: 1,
    minWidth: 0,
    minHeight: 44,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 3,
    borderWidth: 1,
    borderColor: groknight.border,
    color: groknight.textPrimary,
    backgroundColor: groknight.bgBase,
    fontSize: 13,
  },
  panelActions: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 9 },
  primarySmallButton: {
    minHeight: 44,
    paddingHorizontal: 14,
    borderRadius: 3,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: groknight.actionFill,
  },
  primarySmallButtonText: {
    ...Typography.default('semiBold'),
    color: groknight.textInverted,
    fontSize: 13,
  },
  disabled: { backgroundColor: groknight.bgBase, borderWidth: 1, borderColor: groknight.border },
  errorPanel: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    backgroundColor: groknight.bgHighlight,
    borderBottomWidth: 1,
    borderBottomColor: groknight.borderStrong,
  },
  errorLabel: {
    ...Typography.mono('semiBold'),
    color: groknight.textPrimary,
    fontSize: 11,
    lineHeight: 15,
    letterSpacing: 0.8,
  },
  errorText: { ...Typography.default(), color: groknight.chrome, fontSize: 11, lineHeight: 16 },
  retryText: {
    ...Typography.default('semiBold'),
    marginTop: 5,
    color: groknight.textSecondary,
    fontSize: 11,
  },
  listContent: { paddingVertical: 4 },
  dmSection: {
    paddingTop: 8,
    paddingBottom: 4,
    borderTopWidth: 1,
    borderTopColor: groknight.borderStrong,
  },
  sectionHeading: {
    minHeight: 32,
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  sectionTitle: {
    ...Typography.default('semiBold'),
    color: groknight.textSecondary,
    fontSize: 12,
  },
  dmSectionCount: { ...Typography.mono(), color: groknight.textMuted, fontSize: 10 },
  dmRow: {
    minHeight: 62,
    paddingHorizontal: 16,
    paddingVertical: 9,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 11,
    borderTopWidth: 1,
    borderTopColor: groknight.border,
  },
  dmCopy: { flex: 1, minWidth: 0 },
  dmName: {
    ...Typography.default('semiBold'),
    color: groknight.textPrimary,
    fontSize: 14,
  },
  roomCell: {
    ...hairlineDivider,
    backgroundColor: groknight.bgTerminal,
  },
  roomCellExpanded: { backgroundColor: groknight.bgBase },
  roomRow: { minWidth: 0, flexDirection: 'row', alignItems: 'stretch' },
  roomPrimary: { flex: 1, minWidth: 0 },
  channelItem: {
    minHeight: 68,
    paddingHorizontal: 16,
    paddingVertical: 12,
    flexDirection: 'row',
    alignItems: 'center',
  },
  channelInfo: { flex: 1, minWidth: 0 },
  channelTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  channelTitle: {
    ...Typography.default('semiBold'),
    flexShrink: 1,
    color: groknight.textPrimary,
    fontSize: 14,
  },
  archivedTitle: { color: groknight.muted },
  metaTag: {
    ...Typography.default(),
    paddingHorizontal: 5,
    paddingVertical: 2,
    color: groknight.steel,
    backgroundColor: groknight.bgHighlight,
    borderRadius: 3,
    fontSize: 11,
    lineHeight: 15,
  },
  roomMetaRow: {
    marginTop: 4,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  latestMessage: {
    ...Typography.default(),
    flex: 1,
    minWidth: 0,
    color: groknight.textMuted,
    fontSize: 12,
    lineHeight: 16,
  },
  participantCount: {
    ...Typography.mono('semiBold'),
    color: groknight.steel,
    fontSize: 10,
    lineHeight: 14,
  },
  liveMarker: {
    color: groknight.signalMid,
  },
  cornerPeekButton: {
    width: 58,
    minHeight: 68,
    alignItems: 'center',
    justifyContent: 'center',
    borderLeftWidth: 1,
    borderLeftColor: groknight.border,
  },
  cornerPeekCount: {
    ...Typography.mono('semiBold'),
    color: groknight.textMuted,
    fontSize: 10,
    lineHeight: 14,
  },
  cornerPeekChevron: {
    ...Typography.default('semiBold'),
    marginTop: 1,
    color: groknight.steel,
    fontSize: 15,
    lineHeight: 18,
  },
  cornerDropdown: {
    paddingLeft: 40,
    paddingRight: 12,
    paddingBottom: 7,
    borderTopWidth: 1,
    borderTopColor: groknight.border,
    backgroundColor: groknight.bgBase,
  },
  cornerRow: {
    minHeight: 42,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  cornerName: {
    ...Typography.default('semiBold'),
    flex: 1,
    minWidth: 0,
    color: groknight.textSecondary,
    fontSize: 12,
  },
  cornerStatus: {
    ...Typography.mono('semiBold'),
    color: groknight.textMuted,
    fontSize: 9,
    letterSpacing: 0.4,
  },
  emptyContainer: { flexGrow: 1 },
  emptyState: { flex: 1, paddingHorizontal: 22, alignItems: 'center', justifyContent: 'center' },
  emptyGlyph: {
    ...Typography.default(),
    width: 44,
    height: 44,
    borderWidth: 1,
    borderColor: groknight.borderStrong,
    borderRadius: 3,
    color: groknight.steel,
    fontSize: 26,
    lineHeight: 42,
    textAlign: 'center',
  },
  emptyTitle: {
    ...Typography.default('semiBold'),
    marginTop: 12,
    color: groknight.textPrimary,
    fontSize: 16,
    textAlign: 'center',
  },
  emptySubtitle: {
    ...Typography.default(),
    marginTop: 7,
    color: groknight.muted,
    fontSize: 12,
    lineHeight: 18,
    textAlign: 'center',
  },
  primaryButton: {
    marginTop: 18,
    minHeight: 46,
    paddingHorizontal: 18,
    borderRadius: 3,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: groknight.actionFill,
  },
  primaryButtonText: {
    ...Typography.default('semiBold'),
    color: groknight.textInverted,
    fontSize: 13,
  },
});
