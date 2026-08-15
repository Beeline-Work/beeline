import React, { useCallback, useEffect, useRef, useState } from 'react';
import { FlatList, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { router, useLocalSearchParams, type Href } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  isAgentPresenceOnline,
  type Agent,
  type AgentPresence,
  type Community,
  type PersonProfile,
} from '@beeline/buzz-client';
import { getEffectiveRelayUrl, loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import { cornerStatusPresentation, sortCorners, type CornerSummary } from '@/buzz/corners';
import { CHANGES_LABEL, CORNER_LABEL, ROOM_LABEL } from '@/buzz/vocabulary';
import { groknight } from '@/buzz/groknight';
import { resolveAgentDisplayIdentity } from '@/buzz/agent-display';
import { BuzzCommunityShell } from '@/components/buzz/CommunityRail';
import { AgentAvatar } from '@/components/buzz/AgentAvatar';
import { PersonAvatar } from '@/components/buzz/PersonAvatar';
import { HullSurface, PixelLoader } from '@/components/buzz/MonoHull';
import { Typography } from '@/constants/Typography';
import { BuzzRigTransport } from '@/sync/transport';
import {
  agentPresenceFromSessionEvent,
  mergeAgentPresence,
  presenceMapFromSessionEvents,
} from '@/buzz/agent-presence';

export default function BuzzCorners() {
  const { roomId } = useLocalSearchParams<{ roomId: string }>();
  const decodedId = roomId ? decodeURIComponent(roomId) : '';
  const insets = useSafeAreaInsets();
  const [corners, setCorners] = useState<CornerSummary[]>([]);
  const [roomName, setRoomName] = useState(ROOM_LABEL);
  const [communities, setCommunities] = useState<Community[]>([]);
  const [activeCommunityId, setActiveCommunityId] = useState<string | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [personProfiles, setPersonProfiles] = useState<PersonProfile[]>([]);
  const [loading, setLoading] = useState(true);
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
      try {
        const client = await t.ensureClient();
        const [nextCorners, metadata, nextCommunities, communityId, presenceEvents] =
          await Promise.all([
            t.listSubchannelLifecycle(decodedId),
            client.getChannelMetadata(decodedId),
            client.listCommunities(),
            client.getChannelCommunityId(decodedId),
            t.agentPresenceBackfill(decodedId),
          ]);
        setCorners(sortCorners(nextCorners));
        setRoomName(metadata?.name?.trim() || ROOM_LABEL);
        setCommunities(nextCommunities);
        setActiveCommunityId(communityId);
        const workspaceRole = nextCommunities.find(
          (workspace) => workspace.communityId === communityId,
        )?.viewerRole;
        setCanManageWorkspace(workspaceRole === 'owner' || workspaceRole === 'admin');
        setAgentPresences(presenceMapFromSessionEvents(presenceEvents));
        setPresenceNow(Date.now());
        setAgents(communityId ? await client.listAgents(communityId) : []);
        setPersonProfiles(
          communityId
            ? await client.listPersonProfiles(
                communityId,
                nextCorners.map((corner) => corner.openerPubkey),
              )
            : [],
        );
        setViewerPubkey(client.identity.publicKey);
        setViewerAvatarUrl(
          communityId ? (await client.getPersonProfile(communityId))?.avatar : undefined,
        );
      } catch (loadError) {
        setError(String(loadError));
      }
    },
    [decodedId],
  );

  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;
    void (async () => {
      try {
        const identity = await loadBuzzIdentity();
        if (!identity) {
          router.replace('/buzz/onboarding');
          return;
        }
        const t = new BuzzRigTransport(identity, await getEffectiveRelayUrl());
        if (cancelled) return;
        transportRef.current = t;
        await loadCorners(t);
        unsubscribe = t.agentPresenceSubscribe(decodedId, (event) => {
          if (cancelled) return;
          const presence = agentPresenceFromSessionEvent(event);
          if (!presence) return;
          setAgentPresences((current) => mergeAgentPresence(current, presence));
          setPresenceNow(Date.now());
        });
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [decodedId, loadCorners]);

  useEffect(() => {
    const timer = setInterval(() => setPresenceNow(Date.now()), 5_000);
    return () => clearInterval(timer);
  }, []);

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
        router.push(
          { pathname: '/buzz/settings/workspace', params: { communityId } } as unknown as Href,
        )
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
            const agentPresence = agentPresences[item.openerPubkey];
            const displayStatus =
              agent &&
              agentPresence &&
              (item.status === 'live' || item.status === 'open') &&
              !isAgentPresenceOnline(agentPresence, presenceNow)
                ? { glyph: '□', label: 'OFFLINE' }
                : status;
            return (
              <TouchableOpacity
                accessibilityLabel={`View corner ${item.name}, ${displayStatus.label.toLowerCase()}`}
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
                  <Text style={styles.statusGlyph}>{displayStatus.glyph}</Text>
                  <Text style={styles.statusLabel}>{displayStatus.label}</Text>
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
  statusGlyph: { ...Typography.default('semiBold'), color: groknight.steel, fontSize: 13 },
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
