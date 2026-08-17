import React, { useCallback, useEffect, useRef, useState } from 'react';
import { FlatList, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { router, useLocalSearchParams, type Href } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  AGENT_PRESENCE_STALE_MS,
  isAgentPresenceOnline,
  type Agent,
  type AgentPresence,
  type Community,
  type PersonProfile,
} from '@beeline/buzz-client';
import { getEffectiveRelayUrl, loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import {
  cornerStatusPresentation,
  isCornerActive,
  sortCorners,
  type CornerSummary,
} from '@/buzz/corners';
import { CHANGES_LABEL, CORNER_LABEL, ROOM_LABEL } from '@/buzz/vocabulary';
import { groknight } from '@/buzz/groknight';
import { resolveAgentDisplayIdentity } from '@/buzz/agent-display';
import { isWorkspaceManagerRole } from '@/buzz/workspace-role';
import { BuzzCommunityShell } from '@/components/buzz/CommunityRail';
import { AgentAvatar } from '@/components/buzz/AgentAvatar';
import { PersonAvatar } from '@/components/buzz/PersonAvatar';
import { HullSurface, PixelLoader } from '@/components/buzz/MonoHull';
import { Typography } from '@/constants/Typography';
import { BuzzRigTransport } from '@/sync/transport';
import { afterInteractions } from '@/buzz/defer-interaction';
import {
  selectChannelList,
  useBuzzLocalCache,
  type ChannelListCacheEntry,
} from '@/buzz/local-cache';
import {
  agentPresenceFromSessionEvent,
  mergeAgentPresence,
  presenceMapFromSessionEvents,
} from '@/buzz/agent-presence';

/**
 * What the room list already knows about this Room, read synchronously so the
 * first painted frame is real content instead of a spinner. Everything here is
 * refreshed from the relay in the background immediately afterwards.
 */
function seedFromRoomListCache(channelId: string): {
  corners: CornerSummary[];
  roomName: string;
  communities: Community[];
  communityId: string | null;
  hasCache: boolean;
} {
  const state = useBuzzLocalCache.getState();
  const entry: ChannelListCacheEntry | undefined = selectChannelList(
    state,
    state.activeViewerPubkey,
  );
  const room = entry?.channels.find((channel) => channel.id === channelId);
  const corners = room?.corners?.filter((corner) => corner.status !== 'archived') ?? [];
  return {
    corners: sortCorners(corners),
    roomName: room?.title ?? ROOM_LABEL,
    communities: entry?.communities ?? [],
    communityId: entry?.communityId ?? null,
    hasCache: room !== undefined,
  };
}

export default function BuzzCorners() {
  const { roomId } = useLocalSearchParams<{ roomId: string }>();
  const decodedId = roomId ? decodeURIComponent(roomId) : '';
  const insets = useSafeAreaInsets();
  // Seeded synchronously from the room list's own cache. This screen used to
  // hold a full-screen loader across an eight-deep serial relay chain with no
  // cache read at all, which is a blank screen for as long as the network
  // takes — the room list already holds this Room's corners and title.
  const seed = seedFromRoomListCache(decodedId);
  const [corners, setCorners] = useState<CornerSummary[]>(seed.corners);
  const [roomName, setRoomName] = useState(seed.roomName);
  const [communities, setCommunities] = useState<Community[]>(seed.communities);
  const [activeCommunityId, setActiveCommunityId] = useState<string | null>(seed.communityId);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [personProfiles, setPersonProfiles] = useState<PersonProfile[]>([]);
  const [loading, setLoading] = useState(!seed.hasCache);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewerPubkey, setViewerPubkey] = useState<string | undefined>();
  const [viewerAvatarUrl, setViewerAvatarUrl] = useState<string | undefined>();
  const [canManageWorkspace, setCanManageWorkspace] = useState(false);
  const [agentPresences, setAgentPresences] = useState<Record<string, AgentPresence>>({});
  const [presenceNow, setPresenceNow] = useState(Date.now());
  const transportRef = useRef<BuzzRigTransport | null>(null);

  const loadCorners = useCallback(
    async (currentTransport?: BuzzRigTransport) => {
      if (!decodedId) return;
      const t = currentTransport ?? transportRef.current;
      if (!t) return;
      setError(null);
      // Each read publishes its own slice as it lands. Nothing here is
      // sequenced behind an unrelated round-trip, and nothing gates the
      // already-painted cache-seeded list. Every failure lands in `error`;
      // this never rejects, so callers can always settle their own state.
      try {
        const client = await t.ensureClient();
        const communityIdRead = client.getChannelCommunityId(decodedId);
        const cornersRead = t.listSubchannelLifecycle(decodedId);
        const fail = (step: string) => (loadError: unknown) => {
          console.warn(`BuzzCorners: ${step} failed for ${decodedId}:`, loadError);
          setError(String(loadError));
        };

        setViewerPubkey(client.identity.publicKey);

        const cornersApplied = cornersRead.then((nextCorners) => {
          // NIP-29's `closed` metadata flag means invite-only, not archived.
          // `listSubchannelLifecycle` only marks an explicit archive as archived,
          // so keep every live/open corner visible here.
          setCorners(sortCorners(nextCorners.filter((corner) => corner.status !== 'archived')));
          return nextCorners;
        }, fail('corners'));

        const workspaceApplied = Promise.all([
          communityIdRead,
          client.listCommunities().catch((loadError) => {
            fail('communities')(loadError);
            return [] as Community[];
          }),
        ]).then(([communityId, nextCommunities]) => {
          setCommunities(nextCommunities);
          setActiveCommunityId(communityId);
          const workspaceRole = nextCommunities.find(
            (workspace) => workspace.communityId === communityId,
          )?.viewerRole;
          setCanManageWorkspace(isWorkspaceManagerRole(workspaceRole));
          return communityId;
        }, fail('workspace'));

        await Promise.all([
          client
            .getChannelMetadata(decodedId)
            .then(
              (metadata) => setRoomName(metadata?.name?.trim() || ROOM_LABEL),
              fail('roomName'),
            ),
          t.agentPresenceBackfill(decodedId).then((presenceEvents) => {
            setAgentPresences(presenceMapFromSessionEvents(presenceEvents));
            setPresenceNow(Date.now());
          }, fail('presence')),
          cornersApplied,
          workspaceApplied.then(async (communityId) => {
            if (!communityId) {
              setAgents([]);
              setPersonProfiles([]);
              setViewerAvatarUrl(undefined);
              return;
            }
            await Promise.all([
              client.listAgents(communityId).then(setAgents, fail('agents')),
              client
                .getPersonProfile(communityId)
                .then((profile) => setViewerAvatarUrl(profile?.avatar), fail('viewerProfile')),
              Promise.resolve(cornersApplied).then((nextCorners) =>
                client
                  .listPersonProfiles(
                    communityId,
                    (nextCorners ?? []).map((corner) => corner.openerPubkey),
                  )
                  .then(setPersonProfiles, fail('personProfiles')),
              ),
            ]);
          }),
        ]);
      } catch (loadError) {
        setError(String(loadError));
      }
    },
    [decodedId],
  );

  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;
    let cancelDeferred: (() => void) | undefined;
    void (async () => {
      // Local storage reads, not network.
      const identity = await loadBuzzIdentity();
      if (!identity) {
        router.replace('/buzz/onboarding');
        return;
      }
      const t = new BuzzRigTransport(identity, await getEffectiveRelayUrl());
      if (cancelled) return;
      transportRef.current = t;
      // The list is already on screen from cache; refreshing it is background
      // work that must not compete with the navigation transition.
      cancelDeferred = afterInteractions(() => {
        if (cancelled) return;
        void loadCorners(t).finally(() => {
          if (!cancelled) setLoading(false);
        });
        unsubscribe = t.agentPresenceSubscribe(decodedId, (event) => {
          if (cancelled) return;
          const presence = agentPresenceFromSessionEvent(event);
          if (!presence) return;
          setAgentPresences((current) => mergeAgentPresence(current, presence));
          setPresenceNow(Date.now());
        });
      });
    })();
    return () => {
      cancelled = true;
      cancelDeferred?.();
      unsubscribe?.();
    };
  }, [decodedId, loadCorners]);

  useEffect(() => {
    // Presence only changes at a lease deadline. A five-second clock here woke
    // the whole list every five seconds forever; wake once, exactly when the
    // next lease is due, and only while one is actually outstanding.
    const now = Date.now();
    const deadlines = Object.values(agentPresences)
      .map((presence) => presence.observedAt + AGENT_PRESENCE_STALE_MS)
      .filter((deadline) => Number.isFinite(deadline) && deadline > now);
    if (deadlines.length === 0) return;
    const timer = setTimeout(
      () => setPresenceNow(Date.now()),
      Math.max(1, Math.min(...deadlines) - now + 1),
    );
    return () => clearTimeout(timer);
  }, [agentPresences]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadCorners();
    setRefreshing(false);
  }, [loadCorners]);

  const handleCommunitySelect = useCallback((communityId: string | null) => {
    if (!communityId) return;
    router.replace({ pathname: '/buzz/channels', params: { communityId } });
  }, []);

  if (loading) {
    return (
      <View style={[styles.container, styles.center, { paddingTop: insets.top }]}>
        <PixelLoader />
        <Text style={styles.loadingText}>LOADING {CHANGES_LABEL.toUpperCase()}</Text>
      </View>
    );
  }

  return (
    <BuzzCommunityShell
      communities={communities}
      activeCommunityId={activeCommunityId}
      onSelect={handleCommunitySelect}
      onAdd={() => router.push('/buzz/community' as Href)}
      onSettings={() => router.push('/buzz/settings/identity' as Href)}
      onWorkspaceSettings={(communityId) =>
        router.push({
          pathname: '/buzz/settings/workspace',
          params: { communityId },
        } as unknown as Href)
      }
      canManageActiveCommunity={canManageWorkspace}
      viewerPubkey={viewerPubkey}
      viewerAvatarUrl={viewerAvatarUrl}
    >
      <View style={[styles.container, { paddingTop: insets.top }]}>
        <HullSurface strength="quiet" style={styles.header}>
          <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
            <Text style={styles.backText}>‹</Text>
          </TouchableOpacity>
          <View style={styles.headerCopy}>
            <Text style={styles.eyebrow}>{roomName}</Text>
            <Text style={styles.title}>All {CHANGES_LABEL}</Text>
          </View>
          <Text style={styles.count}>{corners.length}</Text>
        </HullSurface>

        <HullSurface strength="raised" style={styles.modelPanel}>
          <Text style={styles.modelTitle}>YOLO INSIDE · HUMAN GATE AT COLLAPSE</Text>
          <Text style={styles.modelText}>
            Agents commit and iterate freely inside their own {CORNER_LABEL}. Only a person can
            approve collapsing it into the protected line. Agents can never approve or merge.
          </Text>
        </HullSurface>

        {error && (
          <View accessibilityRole="alert" style={styles.errorPanel}>
            <Text style={styles.errorText}>! {error}</Text>
          </View>
        )}

        <FlatList
          data={corners}
          keyExtractor={(corner) => corner.id}
          contentContainerStyle={corners.length === 0 ? styles.emptyContainer : undefined}
          refreshing={refreshing}
          onRefresh={() => void handleRefresh()}
          renderItem={({ item }) => {
            const status = cornerStatusPresentation(item.status);
            const agent = agents.find((candidate) => candidate.pubkey === item.openerPubkey);
            const personProfile = personProfiles.find(
              (candidate) => candidate.pubkey === item.openerPubkey,
            );
            const display = resolveAgentDisplayIdentity(item.openerPubkey, agent);
            // Presence is a separate dot, never a replacement for the
            // lifecycle status word shown here — the same word the Room-list
            // dropdown and the in-Room corner card show for this corner.
            const showsPresence = Boolean(agent) && isCornerActive(item.status);
            const online =
              showsPresence &&
              isAgentPresenceOnline(agentPresences[item.openerPubkey], presenceNow);
            return (
              <TouchableOpacity
                accessibilityLabel={`View corner ${item.name}, ${status.label.toLowerCase()}${
                  showsPresence ? (online ? ', agent online' : ', agent offline') : ''
                }`}
                style={styles.cornerRow}
                onPress={() => router.push(`/buzz/chat/${encodeURIComponent(item.id)}`)}
              >
                {agent ? (
                  <AgentAvatar
                    pubkey={item.openerPubkey}
                    avatarSeed={display.avatarSeed}
                    avatarUrl={display.avatarUrl}
                    name={display.name}
                    size={34}
                  />
                ) : (
                  <PersonAvatar
                    pubkey={item.openerPubkey}
                    avatarUrl={personProfile?.avatar}
                    name={personProfile?.name ?? 'Corner opener'}
                    size={34}
                  />
                )}
                <View style={styles.cornerCopy}>
                  <Text style={styles.cornerName} numberOfLines={1}>
                    {item.name}
                  </Text>
                  <Text style={styles.agent} numberOfLines={1}>
                    Opened by{' '}
                    {agent
                      ? display.name
                      : (personProfile?.name ?? `${item.openerPubkey.slice(0, 8)}…`)}
                  </Text>
                </View>
                <View style={styles.statusBlock}>
                  <View style={styles.statusGlyphRow}>
                    <Text style={styles.statusGlyph}>{status.glyph}</Text>
                    {showsPresence && (
                      <Text
                        style={[
                          styles.presenceDot,
                          online ? styles.presenceOnline : styles.presenceOffline,
                        ]}
                      >
                        {online ? '●' : '○'}
                      </Text>
                    )}
                  </View>
                  <Text style={styles.statusLabel}>{status.label}</Text>
                </View>
                <Text style={styles.chevron}>›</Text>
              </TouchableOpacity>
            );
          }}
          ListEmptyComponent={
            <View style={styles.emptyState}>
              <Text style={styles.emptyGlyph}>⌁</Text>
              <Text style={styles.emptyTitle}>No {CHANGES_LABEL} yet</Text>
              <Text style={styles.emptyText}>
                Go back to {roomName} and ask an Agent to start work.
              </Text>
            </View>
          }
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
    letterSpacing: 0.8,
  },
  header: {
    minHeight: 62,
    paddingRight: 16,
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: 1,
    borderBottomColor: groknight.border,
    backgroundColor: groknight.bgBase,
  },
  backButton: { width: 52, height: 52, alignItems: 'center', justifyContent: 'center' },
  backText: { ...Typography.default(), color: groknight.muted, fontSize: 22 },
  headerCopy: { flex: 1, minWidth: 0 },
  eyebrow: {
    ...Typography.default(),
    color: groknight.textMuted,
    fontSize: 11,
    lineHeight: 15,
  },
  title: {
    ...Typography.default('semiBold'),
    color: groknight.textPrimary,
    fontSize: 20,
    lineHeight: 24,
  },
  count: {
    ...Typography.mono('semiBold'),
    marginLeft: 10,
    color: groknight.steel,
    fontSize: 13,
  },
  modelPanel: {
    margin: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: groknight.borderStrong,
    backgroundColor: groknight.bgRaised,
  },
  modelTitle: {
    ...Typography.mono('semiBold'),
    color: groknight.textPrimary,
    fontSize: 10,
    lineHeight: 14,
    letterSpacing: 0.6,
  },
  modelText: {
    ...Typography.default(),
    marginTop: 6,
    color: groknight.textSecondary,
    fontSize: 12,
    lineHeight: 18,
  },
  errorPanel: {
    marginHorizontal: 12,
    marginBottom: 8,
    padding: 10,
    borderWidth: 1,
    borderColor: groknight.borderStrong,
  },
  errorText: { ...Typography.default(), color: groknight.textSecondary, fontSize: 12 },
  cornerRow: {
    minWidth: 0,
    minHeight: 64,
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: 1,
    borderBottomColor: groknight.border,
    backgroundColor: groknight.bgBase,
  },
  cornerCopy: { flex: 1, minWidth: 0, marginLeft: 10 },
  cornerName: {
    ...Typography.default('semiBold'),
    color: groknight.textPrimary,
    fontSize: 14,
  },
  agent: {
    ...Typography.default(),
    marginTop: 4,
    color: groknight.textMuted,
    fontSize: 10,
    lineHeight: 14,
  },
  statusBlock: { minWidth: 70, marginLeft: 8, alignItems: 'flex-end' },
  statusGlyphRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  statusGlyph: { ...Typography.default('semiBold'), color: groknight.steel, fontSize: 13 },
  presenceDot: { ...Typography.default(), fontSize: 8 },
  presenceOnline: { color: groknight.accent },
  presenceOffline: { color: groknight.textMuted },
  statusLabel: {
    ...Typography.mono('semiBold'),
    marginTop: 2,
    color: groknight.textMuted,
    fontSize: 9,
    lineHeight: 12,
  },
  chevron: { ...Typography.default(), marginLeft: 8, color: groknight.gutter, fontSize: 20 },
  emptyContainer: { flexGrow: 1 },
  emptyState: { flex: 1, padding: 24, alignItems: 'center', justifyContent: 'center' },
  emptyGlyph: { ...Typography.default(), color: groknight.steel, fontSize: 28 },
  emptyTitle: {
    ...Typography.default('semiBold'),
    marginTop: 10,
    color: groknight.textPrimary,
    fontSize: 16,
  },
  emptyText: {
    ...Typography.default(),
    marginTop: 6,
    color: groknight.textMuted,
    fontSize: 12,
    lineHeight: 18,
    textAlign: 'center',
  },
});
