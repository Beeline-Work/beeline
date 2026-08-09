import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Platform,
  Share,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { router, useLocalSearchParams, type Href } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Community, Identity } from '@buzzy/buzz-client';
import {
  DEFAULT_RELAY_URL,
  clearBuzzIdentity,
  getEffectiveRelayUrl,
  loadBuzzIdentity,
  saveRelayUrl,
} from '@/auth/buzz-identity-storage';
import { groknight } from '@/buzz/groknight';
import {
  loadActiveCommunityId,
  saveActiveCommunityId,
  saveLastViewedChannel,
} from '@/buzz/community-storage';
import {
  dismissKeyBackupNudge,
  isKeyBackupNudgeDismissed,
} from '@/buzz/key-backup-nudge';
import { BuzzCommunityShell } from '@/components/buzz/CommunityRail';
import { BuzzRigTransport } from '@/sync/transport';
import type { SessionSummary } from '@/sync/transport';

type ChannelDisplayItem = SessionSummary & {
  archived?: boolean;
  isSubchannel?: boolean;
  parentChannelId?: string;
  subchannelCount?: number;
  openerPubkey?: string;
};

function shortPubkey(pubkey: string | undefined): string {
  return pubkey ? `${pubkey.slice(0, 8)}…` : 'unknown';
}

const mono = Platform.select({ web: '"JetBrains Mono", monospace', default: 'monospace' });

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

async function channelSummary(
  transport: BuzzRigTransport,
  channelId: string,
): Promise<ChannelDisplayItem> {
  const client = await transport.ensureClient();
  const metadata = await client.getChannelMetadata(channelId);
  return {
    id: channelId,
    active: !metadata?.archived,
    title: metadata?.name ?? `channel ${channelId.slice(0, 8)}`,
    updatedAt: metadata?.raw?.created_at,
    createdAt: metadata?.raw?.created_at,
    archived: metadata?.archived,
  };
}

async function loadDisplayChannels(
  transport: BuzzRigTransport,
  activeCommunityId: string | null,
  communities: Community[],
): Promise<ChannelDisplayItem[]> {
  const client = await transport.ensureClient();
  let list: ChannelDisplayItem[];

  if (activeCommunityId) {
    const ids = await client.communityChannels(activeCommunityId);
    list = await Promise.all(ids.map((id) => channelSummary(transport, id)));
  } else {
    const all = await transport.sessionsRead();
    const communityIds = new Set(communities.map((community) => community.communityId));
    const memberships = await Promise.all(
      all.map(async (channel) => ({
        channel,
        communityId: await client.getChannelCommunityId(channel.id),
      })),
    );
    list = memberships
      .filter(({ channel, communityId }) => !communityId && !communityIds.has(channel.id))
      .map(({ channel }) => ({ ...channel }));
  }

  const parentIds = new Set<string>();
  const childMap = new Map<string, ChannelDisplayItem[]>();
  const allItems: ChannelDisplayItem[] = [];

  await Promise.all(
    list.map(async (channel) => {
      try {
        const parentId = await transport.getParentChannelId(channel.id);
        const archived = channel.archived ?? (await transport.isChannelArchived(channel.id));
        const item = { ...channel, archived, parentChannelId: parentId ?? undefined };
        if (parentId) {
          item.isSubchannel = true;
          item.openerPubkey = (await transport.getChannelCreator(channel.id)) ?? undefined;
          const siblings = childMap.get(parentId) ?? [];
          siblings.push(item);
          childMap.set(parentId, siblings);
        } else {
          parentIds.add(channel.id);
        }
        allItems.push(item);
      } catch {
        allItems.push(channel);
      }
    }),
  );

  await Promise.all(
    [...parentIds].map(async (parentId) => {
      try {
        const subchannelIds = await transport.listSubchannels(parentId);
        const displayItem = allItems.find((item) => item.id === parentId);
        if (displayItem) displayItem.subchannelCount = subchannelIds.length;
      } catch {
        // A standalone stream need not have subchannels.
      }
    }),
  );

  const grouped: ChannelDisplayItem[] = [];
  for (const item of allItems) {
    if (!item.isSubchannel) {
      grouped.push(item);
      grouped.push(...(childMap.get(item.id) ?? []));
    }
  }
  for (const item of allItems) {
    if (item.isSubchannel && !grouped.includes(item)) grouped.push(item);
  }
  return grouped;
}

export default function BuzzChannels() {
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{
    communityId?: string | string[];
    inviteUrl?: string | string[];
  }>();
  const requestedCommunity = firstParam(params.communityId);
  const inviteUrl = firstParam(params.inviteUrl);

  const [identity, setIdentity] = useState<Identity | null>(null);
  const [transport, setTransport] = useState<BuzzRigTransport | null>(null);
  const [communities, setCommunities] = useState<Community[]>([]);
  const [activeCommunityId, setActiveCommunityId] = useState<string | null>(null);
  const [displayChannels, setDisplayChannels] = useState<ChannelDisplayItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [relayUrl, setRelayUrl] = useState(DEFAULT_RELAY_URL);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsRelayUrl, setSettingsRelayUrl] = useState('');
  const [showCreateChannel, setShowCreateChannel] = useState(false);
  const [channelName, setChannelName] = useState('');
  const [creatingChannel, setCreatingChannel] = useState(false);
  const [viewerIsAgent, setViewerIsAgent] = useState(false);
  const [showBackupNudge, setShowBackupNudge] = useState(false);

  const activeCommunity = useMemo(
    () => communities.find((community) => community.communityId === activeCommunityId) ?? null,
    [communities, activeCommunityId],
  );

  const resolveCommunity = useCallback(
    async (currentIdentity: Identity, available: Community[]): Promise<string | null> => {
      const requested = requestedCommunity;
      if (requested === 'standalone') return null;
      if (requested && available.some((community) => community.communityId === requested)) {
        return requested;
      }
      const stored = await loadActiveCommunityId(currentIdentity.publicKey);
      return available.some((community) => community.communityId === stored) ? stored : null;
    },
    [requestedCommunity],
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setError(null);
      try {
        const currentIdentity = await loadBuzzIdentity();
        if (!currentIdentity) {
          router.replace('/buzz/onboarding');
          return;
        }
        const nudgeDismissed = await isKeyBackupNudgeDismissed(currentIdentity.publicKey);
        if (!cancelled) setShowBackupNudge(!nudgeDismissed);
        const url = await getEffectiveRelayUrl();
        const nextTransport = new BuzzRigTransport(currentIdentity, url);
        const client = await nextTransport.ensureClient();
        const [available, identityIsAgent] = await Promise.all([
          client.listCommunities(),
          client.isAgentIdentity(currentIdentity.publicKey),
        ]);
        const active = await resolveCommunity(currentIdentity, available);
        const channels = await loadDisplayChannels(nextTransport, active, available);
        await saveActiveCommunityId(currentIdentity.publicKey, active);
        if (!cancelled) {
          setIdentity(currentIdentity);
          setRelayUrl(url);
          setTransport(nextTransport);
          setCommunities(available);
          setActiveCommunityId(active);
          setDisplayChannels(channels);
          setViewerIsAgent(identityIsAgent);
        }
      } catch (err) {
        if (!cancelled) setError(String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [resolveCommunity]);

  const handleSelectCommunity = useCallback((communityId: string | null) => {
    router.replace({
      pathname: '/buzz/channels',
      params: { communityId: communityId ?? 'standalone' },
    });
  }, []);

  const handleRefresh = useCallback(async () => {
    if (!transport || !identity) return;
    setRefreshing(true);
    setError(null);
    try {
      const client = await transport.ensureClient();
      const available = await client.listCommunities();
      const active = available.some((community) => community.communityId === activeCommunityId)
        ? activeCommunityId
        : null;
      setCommunities(available);
      setActiveCommunityId(active);
      setDisplayChannels(await loadDisplayChannels(transport, active, available));
      await saveActiveCommunityId(identity.publicKey, active);
    } catch (err) {
      setError(String(err));
    } finally {
      setRefreshing(false);
    }
  }, [activeCommunityId, identity, transport]);

  const handleChannelPress = useCallback(
    async (channel: ChannelDisplayItem) => {
      if (identity) {
        await saveLastViewedChannel(identity.publicKey, activeCommunityId, channel.id);
      }
      router.push(`/buzz/chat/${encodeURIComponent(channel.id)}`);
    },
    [activeCommunityId, identity],
  );

  const handleCreateChannel = useCallback(async () => {
    const name = channelName.trim();
    if (!name || !transport || viewerIsAgent) return;
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
      setDisplayChannels(await loadDisplayChannels(transport, activeCommunityId, communities));
    } catch (err) {
      setError(`Could not create channel: ${String(err)}`);
    } finally {
      setCreatingChannel(false);
    }
  }, [activeCommunityId, channelName, communities, transport, viewerIsAgent]);

  const handleSaveRelayUrl = useCallback(async () => {
    if (!identity) return;
    const url = settingsRelayUrl.trim() || DEFAULT_RELAY_URL;
    setLoading(true);
    setError(null);
    try {
      await saveRelayUrl(url);
      const nextTransport = new BuzzRigTransport(identity, url);
      const client = await nextTransport.ensureClient();
      const available = await client.listCommunities();
      const active = available.some((community) => community.communityId === activeCommunityId)
        ? activeCommunityId
        : null;
      setTransport(nextTransport);
      setCommunities(available);
      setActiveCommunityId(active);
      setRelayUrl(url);
      setShowSettings(false);
      setDisplayChannels(await loadDisplayChannels(nextTransport, active, available));
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [activeCommunityId, identity, settingsRelayUrl]);

  const handleLogout = useCallback(async () => {
    await clearBuzzIdentity();
    router.replace('/buzz/onboarding');
  }, []);

  const handleDismissBackupNudge = useCallback(async () => {
    if (!identity) return;
    setShowBackupNudge(false);
    try {
      await dismissKeyBackupNudge(identity.publicKey);
    } catch {
      // Dismissal is best-effort; a storage failure may show the gentle nudge again.
    }
  }, [identity]);

  if (loading && !transport) {
    return (
      <View style={[styles.container, styles.center, { paddingTop: insets.top }]}>
        <ActivityIndicator size="large" color={groknight.accent} />
        <Text style={styles.loadingText}>connecting to relay…</Text>
      </View>
    );
  }

  return (
    <BuzzCommunityShell
      communities={communities}
      activeCommunityId={activeCommunityId}
      onSelect={handleSelectCommunity}
      onAdd={() => router.push('/buzz/community' as Href)}
    >
      <View style={[styles.container, { paddingTop: insets.top }]}>
        <View style={styles.header}>
          <View style={styles.headerIdentity}>
            <Text style={styles.eyebrow}>{activeCommunity ? 'community' : 'buzzy home'}</Text>
            <Text style={styles.headerTitle} numberOfLines={1}>
              {activeCommunity?.name ?? 'standalone'}
            </Text>
          </View>
          <View style={styles.headerActions}>
            {activeCommunityId && (
              <TouchableOpacity
                accessibilityLabel="Community agents"
                onPress={() =>
                  router.push(
                    `/buzz/agents?communityId=${encodeURIComponent(activeCommunityId)}` as Href,
                  )
                }
                style={styles.iconButton}
              >
                <Text style={styles.iconButtonText}>⌬</Text>
              </TouchableOpacity>
            )}
            {!viewerIsAgent && (
              <TouchableOpacity
                accessibilityLabel="Create human discussion channel"
                onPress={() => setShowCreateChannel((value) => !value)}
                style={styles.iconButton}
              >
                <Text style={styles.iconButtonText}>＋#</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity
              accessibilityLabel="Settings"
              onPress={() => {
                setSettingsRelayUrl(relayUrl);
                setShowSettings((value) => !value);
              }}
              style={styles.iconButton}
            >
              <Text style={styles.iconButtonText}>⚙</Text>
            </TouchableOpacity>
          </View>
        </View>

        {showBackupNudge && (
          <View style={styles.backupNudge}>
            <View style={styles.backupNudgeCopy}>
              <Text style={styles.backupNudgeTitle}>Back up your key</Text>
              <Text style={styles.backupNudgeText}>
                If this device is lost or wiped before you export, your Buzzy identity is lost too.
              </Text>
            </View>
            <View style={styles.backupNudgeActions}>
              <TouchableOpacity
                onPress={() => router.push('/buzz/settings/identity' as Href)}
                style={styles.nudgeAction}
              >
                <Text style={styles.nudgeActionText}>back up now</Text>
              </TouchableOpacity>
              <TouchableOpacity
                accessibilityLabel="Dismiss key backup reminder"
                onPress={() => void handleDismissBackupNudge()}
                style={styles.dismissNudge}
              >
                <Text style={styles.dismissNudgeText}>×</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        {inviteUrl && (
          <View style={styles.invitePanel}>
            <Text style={styles.panelEyebrow}>invite ready</Text>
            <Text style={styles.inviteUrl} numberOfLines={2}>
              {inviteUrl}
            </Text>
            <View style={styles.panelActions}>
              <TouchableOpacity
                style={styles.primarySmallButton}
                onPress={() => Share.share({ message: inviteUrl })}
              >
                <Text style={styles.primarySmallButtonText}>share</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.secondarySmallButton}
                onPress={() => Clipboard.setStringAsync(inviteUrl)}
              >
                <Text style={styles.secondarySmallButtonText}>copy link</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        {showCreateChannel && !viewerIsAgent && (
          <View style={styles.actionPanel}>
            <Text style={styles.panelEyebrow}>
              new channel · {activeCommunity?.name ?? 'standalone'}
            </Text>
            <View style={styles.inlineForm}>
              <TextInput
                autoFocus
                style={styles.input}
                value={channelName}
                onChangeText={setChannelName}
                onSubmitEditing={() => void handleCreateChannel()}
                placeholder="channel name"
                placeholderTextColor={groknight.dim}
                editable={!creatingChannel}
              />
              <TouchableOpacity
                style={[styles.primarySmallButton, !channelName.trim() && styles.disabled]}
                disabled={!channelName.trim() || creatingChannel}
                onPress={() => void handleCreateChannel()}
              >
                <Text style={styles.primarySmallButtonText}>
                  {creatingChannel ? 'creating…' : 'create'}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        {showSettings && (
          <View style={styles.actionPanel}>
            <Text style={styles.panelEyebrow}>settings</Text>
            <TouchableOpacity
              accessibilityLabel="Open identity and backup settings"
              onPress={() => router.push('/buzz/settings/identity' as Href)}
              style={styles.identitySettingsRow}
            >
              <View style={styles.identitySettingsCopy}>
                <Text style={styles.identitySettingsTitle}>identity &amp; backup</Text>
                <Text style={styles.identitySettingsSubtitle}>export your secret key</Text>
              </View>
              <Text style={styles.identitySettingsChevron}>›</Text>
            </TouchableOpacity>
            <Text style={styles.panelEyebrow}>relay url</Text>
            <TextInput
              style={styles.input}
              value={settingsRelayUrl}
              onChangeText={setSettingsRelayUrl}
              placeholder={DEFAULT_RELAY_URL}
              placeholderTextColor={groknight.dim}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
            />
            <View style={styles.panelActions}>
              <TouchableOpacity style={styles.primarySmallButton} onPress={handleSaveRelayUrl}>
                <Text style={styles.primarySmallButtonText}>save</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.secondarySmallButton} onPress={handleLogout}>
                <Text style={styles.secondarySmallButtonText}>forget key</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        {error && (
          <View style={styles.errorPanel}>
            <Text accessibilityRole="alert" style={styles.errorText}>
              {error}
            </Text>
            <TouchableOpacity onPress={() => void handleRefresh()}>
              <Text style={styles.retryText}>retry</Text>
            </TouchableOpacity>
          </View>
        )}

        <FlatList
          data={displayChannels}
          keyExtractor={(item) => item.id}
          contentContainerStyle={
            displayChannels.length === 0 ? styles.emptyContainer : styles.listContent
          }
          ListEmptyComponent={
            <View style={styles.emptyState}>
              <Text style={styles.emptyGlyph}>⌁</Text>
              <Text style={styles.emptyTitle}>
                {activeCommunity ? 'No channels here yet' : 'No standalone channels'}
              </Text>
              <Text style={styles.emptySubtitle}>
                {activeCommunity
                  ? `Open a first room inside ${activeCommunity.name}.`
                  : 'Community channels live behind their icons in the rail.'}
              </Text>
              {!viewerIsAgent && (
                <TouchableOpacity
                  style={styles.primaryButton}
                  onPress={() => setShowCreateChannel(true)}
                >
                  <Text style={styles.primaryButtonText}>create discussion channel</Text>
                </TouchableOpacity>
              )}
            </View>
          }
          renderItem={({ item }) => (
            <TouchableOpacity
              style={[styles.channelItem, item.isSubchannel && styles.subchannelItem]}
              onPress={() => void handleChannelPress(item)}
            >
              <Text style={styles.channelIcon}>
                {item.archived ? '□' : item.isSubchannel ? '↳' : '#'}
              </Text>
              <View style={styles.channelInfo}>
                <View style={styles.channelTitleRow}>
                  <Text
                    numberOfLines={1}
                    style={[
                      styles.channelTitle,
                      item.isSubchannel && styles.subchannelTitle,
                      item.archived && styles.archivedTitle,
                    ]}
                  >
                    {item.title ?? `channel ${item.id.slice(0, 8)}`}
                  </Text>
                  {item.archived && <Text style={styles.metaTag}>archived</Text>}
                </View>
                <Text style={styles.channelMeta}>
                  {item.id.slice(0, 10)}
                  {item.subchannelCount ? ` · ${item.subchannelCount} sub` : ''}
                  {item.isSubchannel ? ` · agent ${shortPubkey(item.openerPubkey)}` : ''}
                  {item.isSubchannel ? item.archived ? ' · closed' : ' · live' : ''}
                </Text>
              </View>
              <Text style={styles.chevron}>›</Text>
            </TouchableOpacity>
          )}
          onRefresh={() => void handleRefresh()}
          refreshing={refreshing}
        />
      </View>
    </BuzzCommunityShell>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, minWidth: 0, backgroundColor: groknight.bgTerminal },
  center: { alignItems: 'center', justifyContent: 'center' },
  loadingText: { marginTop: 12, color: groknight.muted, fontFamily: mono, fontSize: 13 },
  header: {
    minHeight: 66,
    paddingHorizontal: 14,
    paddingVertical: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: groknight.bgBase,
    borderBottomWidth: 1,
    borderBottomColor: groknight.border,
  },
  headerIdentity: { flex: 1, minWidth: 0 },
  eyebrow: {
    color: groknight.steel,
    fontFamily: mono,
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 1.4,
    textTransform: 'uppercase',
  },
  headerTitle: { marginTop: 3, color: groknight.textPrimary, fontSize: 18, fontWeight: '800' },
  headerActions: { flexDirection: 'row', gap: 6, marginLeft: 8 },
  iconButton: {
    minWidth: 36,
    height: 36,
    paddingHorizontal: 7,
    borderRadius: 5,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: groknight.borderActive,
    backgroundColor: groknight.bgHighlight,
  },
  iconButtonText: { color: groknight.chrome, fontSize: 15, fontFamily: mono },
  actionPanel: {
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: groknight.border,
    backgroundColor: groknight.bgBase,
  },
  backupNudge: {
    paddingHorizontal: 14,
    paddingVertical: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderBottomWidth: 1,
    borderBottomColor: groknight.borderActive,
    backgroundColor: groknight.bgCode,
  },
  backupNudgeCopy: { flex: 1, minWidth: 0 },
  backupNudgeTitle: {
    color: groknight.textPrimary,
    fontFamily: mono,
    fontSize: 12,
    fontWeight: '800',
  },
  backupNudgeText: {
    marginTop: 3,
    color: groknight.muted,
    fontFamily: mono,
    fontSize: 10,
    lineHeight: 15,
  },
  backupNudgeActions: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  nudgeAction: { minHeight: 36, paddingHorizontal: 10, alignItems: 'center', justifyContent: 'center' },
  nudgeActionText: { color: groknight.accent, fontFamily: mono, fontSize: 10, fontWeight: '800' },
  dismissNudge: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  dismissNudgeText: { color: groknight.steel, fontFamily: mono, fontSize: 20, lineHeight: 22 },
  identitySettingsRow: {
    minHeight: 52,
    marginBottom: 14,
    paddingHorizontal: 11,
    paddingVertical: 8,
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: groknight.borderActive,
    borderRadius: 4,
    backgroundColor: groknight.bgHighlight,
  },
  identitySettingsCopy: { flex: 1, minWidth: 0 },
  identitySettingsTitle: { color: groknight.textPrimary, fontSize: 13, fontWeight: '700' },
  identitySettingsSubtitle: { marginTop: 3, color: groknight.muted, fontFamily: mono, fontSize: 10 },
  identitySettingsChevron: { marginLeft: 8, color: groknight.chrome, fontSize: 22 },
  invitePanel: {
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: groknight.accent,
    backgroundColor: groknight.bgCode,
  },
  panelEyebrow: {
    marginBottom: 7,
    color: groknight.accent,
    fontFamily: mono,
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },
  inviteUrl: { color: groknight.textSecondary, fontFamily: mono, fontSize: 11, lineHeight: 16 },
  inlineForm: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  input: {
    flex: 1,
    minWidth: 0,
    minHeight: 40,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: groknight.borderActive,
    color: groknight.textPrimary,
    backgroundColor: groknight.bgTerminal,
    fontFamily: mono,
    fontSize: 13,
  },
  panelActions: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 9 },
  primarySmallButton: {
    minHeight: 36,
    paddingHorizontal: 14,
    borderRadius: 4,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: groknight.accent,
  },
  primarySmallButtonText: {
    color: groknight.bgTerminal,
    fontFamily: mono,
    fontWeight: '800',
    fontSize: 12,
  },
  secondarySmallButton: {
    minHeight: 36,
    paddingHorizontal: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondarySmallButtonText: { color: groknight.chrome, fontFamily: mono, fontSize: 12 },
  disabled: { opacity: 0.45 },
  errorPanel: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    backgroundColor: groknight.bgHighlight,
    borderBottomWidth: 1,
    borderBottomColor: groknight.borderActive,
  },
  errorText: { color: groknight.chrome, fontFamily: mono, fontSize: 11, lineHeight: 16 },
  retryText: {
    marginTop: 5,
    color: groknight.accent,
    fontFamily: mono,
    fontSize: 11,
    fontWeight: '700',
  },
  listContent: { paddingVertical: 4 },
  channelItem: {
    minHeight: 66,
    paddingHorizontal: 14,
    paddingVertical: 10,
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: 1,
    borderBottomColor: groknight.border,
  },
  subchannelItem: { paddingLeft: 25, backgroundColor: groknight.bgBase },
  channelIcon: {
    width: 25,
    color: groknight.steel,
    fontFamily: mono,
    fontSize: 15,
    fontWeight: '700',
  },
  channelInfo: { flex: 1, minWidth: 0 },
  channelTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  channelTitle: { flexShrink: 1, color: groknight.textPrimary, fontSize: 14, fontWeight: '700' },
  subchannelTitle: { color: groknight.textSecondary, fontSize: 13 },
  archivedTitle: { color: groknight.muted },
  metaTag: {
    paddingHorizontal: 5,
    paddingVertical: 2,
    color: groknight.steel,
    backgroundColor: groknight.bgHighlight,
    borderRadius: 3,
    fontFamily: mono,
    fontSize: 8,
    textTransform: 'uppercase',
  },
  channelMeta: {
    marginTop: 4,
    color: groknight.dim,
    fontFamily: mono,
    fontSize: 9,
    letterSpacing: 0.4,
  },
  chevron: { marginLeft: 8, color: groknight.gutter, fontSize: 22 },
  emptyContainer: { flexGrow: 1 },
  emptyState: { flex: 1, paddingHorizontal: 22, alignItems: 'center', justifyContent: 'center' },
  emptyGlyph: { color: groknight.gutter, fontSize: 34, fontFamily: mono },
  emptyTitle: {
    marginTop: 12,
    color: groknight.textPrimary,
    fontSize: 16,
    fontWeight: '800',
    textAlign: 'center',
  },
  emptySubtitle: {
    marginTop: 7,
    color: groknight.muted,
    fontFamily: mono,
    fontSize: 11,
    lineHeight: 17,
    textAlign: 'center',
  },
  primaryButton: {
    marginTop: 18,
    minHeight: 42,
    paddingHorizontal: 18,
    borderRadius: 4,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: groknight.accent,
  },
  primaryButtonText: {
    color: groknight.bgTerminal,
    fontFamily: mono,
    fontWeight: '800',
    fontSize: 12,
  },
});
