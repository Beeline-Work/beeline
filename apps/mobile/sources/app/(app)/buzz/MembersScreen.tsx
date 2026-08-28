import React, { useEffect, useRef, useState } from 'react';
import { ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { router, useLocalSearchParams, type Href } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  RoomViewClient,
  SurfaceRefreshScheduler,
  isAgentDetailView,
  isWorkspaceView,
  type AgentDetailView,
  type Identity,
  type WorkspaceView,
} from '@beeline/buzz-client';
import { getEffectiveRelayUrl, loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import { mobileSurfaceCache, surfaceAddress } from '@/buzz/surface-storage';
import { IdentityMark } from '@/components/buzz/IdentityMark';
import { HullSurface, MonoButton, PixelLoader } from '@/components/buzz/MonoHull';
import { MEMBERS_LABEL } from '@/buzz/vocabulary';
import { BuzzRigTransport } from '@/sync/transport';
import { Typography } from '@/constants/Typography';
import { BuzzCommunityShell } from '@/components/buzz/CommunityRail';
import { workspaceRailItem } from '@/buzz/room-view-presentation';

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default function BuzzMembers() {
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ communityId?: string | string[] }>();
  const workspaceId = first(params.communityId);
  const [surface, setSurface] = useState<WorkspaceView | null>(null);
  const [selectedAgent, setSelectedAgent] = useState<AgentDetailView | null>(null);
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [relayUrl, setRelayUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retryGeneration, setRetryGeneration] = useState(0);
  const schedulerRef = useRef<SurfaceRefreshScheduler<WorkspaceView> | null>(null);
  const agentRequestGenerationRef = useRef(0);

  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;
    let scheduler: SurfaceRefreshScheduler<WorkspaceView> | undefined;
    void (async () => {
      const nextIdentity = await loadBuzzIdentity();
      if (!nextIdentity) {
        router.replace('/buzz/onboarding');
        return;
      }
      const nextRelayUrl = await getEffectiveRelayUrl();
      const address = surfaceAddress(nextRelayUrl, nextIdentity.publicKey, '/workspace/:id', {
        workspaceId,
      });
      const cached = await mobileSurfaceCache.read(address, isWorkspaceView);
      if (cancelled) return;
      setIdentity(nextIdentity);
      setRelayUrl(nextRelayUrl);
      if (cached) setSurface(cached);
      const http = new RoomViewClient({ baseUrl: nextRelayUrl, identity: nextIdentity });
      scheduler = new SurfaceRefreshScheduler({
        fetch: () => http.workspace(workspaceId),
        apply: (value) => {
          setSurface(value);
          setError(null);
          void mobileSurfaceCache.write(address, value, isWorkspaceView);
        },
        onError: (reason) => setError(String(reason)),
      });
      schedulerRef.current = scheduler;
      const relay = await new BuzzRigTransport(nextIdentity, nextRelayUrl).ensureClient();
      unsubscribe = await relay.surfaceSubscribe(
        cached?.watchFilters ?? [{ kinds: [0, 9, 9000, 9001], '#h': [workspaceId] }],
        () => scheduler?.signal(),
      );
      if (cancelled) return unsubscribe();
      await scheduler.startAfter(Promise.resolve());
    })().catch((reason) => {
      if (!cancelled) setError(String(reason));
    });
    return () => {
      cancelled = true;
      agentRequestGenerationRef.current += 1;
      unsubscribe?.();
      scheduler?.dispose();
      schedulerRef.current = null;
    };
  }, [retryGeneration, workspaceId]);

  const openAgent = async (agentPubkey: string) => {
    if (!identity || !relayUrl || !workspaceId) return;
    const generation = ++agentRequestGenerationRef.current;
    const address = surfaceAddress(relayUrl, identity.publicKey, '/workspace/:id/agents/:agentId', {
      workspaceId,
      agentPubkey,
    });
    try {
      const cached = await mobileSurfaceCache.read(address, isAgentDetailView);
      if (generation !== agentRequestGenerationRef.current) return;
      if (cached) setSelectedAgent(cached);
      const value = await new RoomViewClient({ baseUrl: relayUrl, identity }).agent(
        workspaceId,
        agentPubkey,
      );
      if (generation !== agentRequestGenerationRef.current) return;
      setSelectedAgent(value);
      await mobileSurfaceCache.write(address, value, isAgentDetailView);
    } catch (reason) {
      if (generation === agentRequestGenerationRef.current) setError(String(reason));
    }
  };

  if (!surface && !error) {
    return (
      <View style={[styles.container, styles.center, { paddingTop: insets.top }]}>
        <PixelLoader />
        <Text style={styles.loading}>LOADING {MEMBERS_LABEL.toUpperCase()}</Text>
      </View>
    );
  }
  if (!surface) {
    return (
      <View style={[styles.container, styles.center, { paddingTop: insets.top }]}>
        <Text style={styles.error}>{error}</Text>
        <MonoButton label="RETRY" onPress={() => setRetryGeneration((value) => value + 1)} />
      </View>
    );
  }

  return (
    <BuzzCommunityShell
      communities={[workspaceRailItem(surface.workspace)]}
      activeCommunityId={surface.workspace.id}
      onSelect={(communityId) =>
        communityId &&
        router.replace({ pathname: '/buzz/channels', params: { communityId } } as never)
      }
      onAdd={() => router.push('/buzz/community' as Href)}
      onSettings={() => router.push('/buzz/settings' as Href)}
      onWorkspaceSettings={(communityId) =>
        router.push({ pathname: '/buzz/settings/workspace', params: { communityId } } as never)
      }
      canManageActiveCommunity={surface.viewer.permissions.manage}
      viewerPubkey={surface.viewer.identity.pubkey}
      viewerAvatarUrl={surface.viewer.identity.avatar}
    >
      <View style={[styles.container, { paddingTop: insets.top }]}>
        <HullSurface strength="quiet" style={styles.header}>
          <TouchableOpacity onPress={() => router.back()} style={styles.back}>
            <Text style={styles.backText}>‹</Text>
          </TouchableOpacity>
          <View style={styles.headerCopy}>
            <Text style={styles.eyebrow}>{surface.workspace.name}</Text>
            <Text style={styles.title}>{MEMBERS_LABEL}</Text>
          </View>
          <Text style={styles.count}>{surface.members.length + surface.agents.length}</Text>
        </HullSurface>
        {!!error && (
          <TouchableOpacity onPress={() => schedulerRef.current?.force()} style={styles.errorPanel}>
            <Text style={styles.error}>! {error}</Text>
          </TouchableOpacity>
        )}
        <ScrollView contentContainerStyle={styles.content}>
          <View style={styles.section} testID="members-people-section">
            <View style={styles.sectionHeading}>
              <Text style={styles.sectionTitle}>PEOPLE</Text>
              <Text style={styles.count} testID="members-people-count">
                {surface.members.length}
              </Text>
            </View>
            {surface.members.map((member) => (
              <View
                key={member.identity.pubkey}
                style={styles.row}
                testID={`member-${member.identity.pubkey}-identity`}
              >
                <IdentityMark
                  kind="human"
                  seed={member.identity.pubkey}
                  avatarUrl={member.identity.avatar}
                  name={member.identity.name}
                  size={38}
                />
                <View style={styles.rowCopy}>
                  <Text style={styles.name}>{member.identity.name}</Text>
                  <Text style={styles.detail}>
                    {member.identity.handle ?? member.identity.pubkey.slice(0, 12)} ·{' '}
                    {member.role.toUpperCase()}
                  </Text>
                </View>
              </View>
            ))}
          </View>
          <View style={styles.section} testID="members-agents-section">
            <View style={styles.sectionHeading}>
              <Text style={styles.sectionTitle}>AGENTS</Text>
              <Text style={styles.count}>{surface.agents.length}</Text>
            </View>
            {surface.agents.map((member) => (
              <TouchableOpacity
                key={member.identity.pubkey}
                style={styles.row}
                onPress={() => void openAgent(member.identity.pubkey)}
                testID={`agent-${member.identity.pubkey}-identity`}
              >
                <IdentityMark
                  kind="agent"
                  seed={member.identity.pubkey}
                  avatarUrl={member.identity.avatar}
                  name={member.identity.name}
                  size={38}
                  alive={member.presence?.status === 'online'}
                />
                <View style={styles.rowCopy}>
                  <Text style={styles.name}>{member.identity.name}</Text>
                  <Text style={styles.detail}>
                    {member.presence?.status.toUpperCase() ?? 'OFFLINE'} ·{' '}
                    {member.role.toUpperCase()}
                  </Text>
                </View>
                <Text style={styles.chevron}>›</Text>
              </TouchableOpacity>
            ))}
          </View>
          {selectedAgent && (
            <HullSurface
              strength="raised"
              style={styles.detailPanel}
              testID={`agent-${selectedAgent.agent.identity.pubkey}-model-config`}
            >
              <Text style={styles.sectionTitle}>
                {selectedAgent.agent.identity.name.toUpperCase()}
              </Text>
              <Text style={styles.detail}>
                {selectedAgent.selected?.model ??
                  selectedAgent.runtimeSelection?.model ??
                  'Default model'}
              </Text>
              <Text style={styles.detail}>
                {selectedAgent.catalog.length} configuration axes available
              </Text>
              <MonoButton
                label="CLOSE"
                variant="secondary"
                onPress={() => {
                  agentRequestGenerationRef.current += 1;
                  setSelectedAgent(null);
                }}
              />
            </HullSurface>
          )}
        </ScrollView>
      </View>
    </BuzzCommunityShell>
  );
}

const styles = StyleSheet.create((theme) => {
  const hull = theme.buzz;
  return {
    container: { flex: 1, backgroundColor: hull.bgTerminal },
    center: { alignItems: 'center', justifyContent: 'center', gap: 14, paddingHorizontal: 28 },
    loading: {
      ...Typography.mono('semiBold'),
      color: hull.textMuted,
      fontSize: 10,
      letterSpacing: 1,
    },
    header: {
      minHeight: 66,
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: hull.border,
    },
    back: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
    backText: { color: hull.textPrimary, fontSize: 30 },
    headerCopy: { flex: 1 },
    eyebrow: { ...Typography.mono(), color: hull.textMuted, fontSize: 9 },
    title: { ...Typography.default('semiBold'), color: hull.textPrimary, fontSize: 18 },
    count: { ...Typography.mono('semiBold'), color: hull.chrome, fontSize: 11 },
    errorPanel: { padding: 9 },
    error: { ...Typography.default(), color: hull.danger, fontSize: 11, textAlign: 'center' },
    content: { padding: 14, gap: 16, paddingBottom: 40 },
    section: { borderWidth: StyleSheet.hairlineWidth, borderColor: hull.border },
    sectionHeading: {
      height: 38,
      paddingHorizontal: 12,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      backgroundColor: hull.bgRaised,
    },
    sectionTitle: {
      ...Typography.mono('semiBold'),
      color: hull.textMuted,
      fontSize: 9,
      letterSpacing: 0.8,
    },
    row: {
      minHeight: 62,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 11,
      paddingHorizontal: 12,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: hull.border,
    },
    rowCopy: { flex: 1, minWidth: 0 },
    name: { ...Typography.default('semiBold'), color: hull.textPrimary, fontSize: 14 },
    detail: { ...Typography.default(), color: hull.textMuted, fontSize: 11, marginTop: 3 },
    chevron: { color: hull.textMuted, fontSize: 22 },
    detailPanel: { padding: 14, gap: 10 },
  };
});
