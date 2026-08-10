import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Share,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { router, useLocalSearchParams, type Href } from 'expo-router';
import { useFocusEffect } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Community, Identity } from '@beeline/buzz-client';
import {
  DEFAULT_RELAY_URL,
  clearBuzzIdentity,
  getEffectiveRelayUrl,
  loadBuzzIdentity,
  saveRelayUrl,
} from '@/auth/buzz-identity-storage';
import { groknight } from '@/buzz/groknight';
import { saveLastViewedChannel } from '@/buzz/community-storage';
import { createCommunityInviteUrl } from '@/buzz/community-invite';
import { prepareWorkspaceContext } from '@/buzz/workspace-bootstrap';
import { CHANGE_LABEL, ROOM_LABEL, ROOMS_LABEL, WORKSPACE_LABEL } from '@/buzz/vocabulary';
import { CommunityInviteEntry } from '@/components/buzz/CommunityInviteEntry';
import { BuzzCommunityShell, CommunityDrawerTrigger } from '@/components/buzz/CommunityRail';
import { BuzzRigTransport } from '@/sync/transport';
import type { SessionSummary } from '@/sync/transport';
import { Typography } from '@/constants/Typography';

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
    title: metadata?.name ?? `${ROOM_LABEL.toLowerCase()} ${channelId.slice(0, 8)}`,
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
        // A legacy unscoped stream need not have child streams.
      }
    }),
  );

  // A change belongs to its Room's live review surface, not Workspace navigation.
  return allItems.filter((item) => !item.isSubchannel);
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
  const [creatingInvite, setCreatingInvite] = useState(false);
  const [readyInviteUrl, setReadyInviteUrl] = useState<string | undefined>(inviteUrl);

  const activeCommunity = useMemo(
    () => communities.find((community) => community.communityId === activeCommunityId) ?? null,
    [communities, activeCommunityId],
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
        const url = await getEffectiveRelayUrl();
        const nextTransport = new BuzzRigTransport(currentIdentity, url);
        const client = await nextTransport.ensureClient();
        const [workspaceContext, identityIsAgent] = await Promise.all([
          prepareWorkspaceContext(client, currentIdentity.publicKey, requestedCommunity),
          client.isAgentIdentity(currentIdentity.publicKey),
        ]);
        const { workspaces: available, activeWorkspaceId: active } = workspaceContext;
        const channels = await loadDisplayChannels(nextTransport, active, available);
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
  }, [requestedCommunity]);

  const handleSelectCommunity = useCallback((communityId: string | null) => {
    if (!communityId) return;
    setReadyInviteUrl(undefined);
    router.replace({
      pathname: '/buzz/channels',
      params: { communityId },
    });
  }, []);

  const handleRefresh = useCallback(async () => {
    if (!transport || !identity) return;
    setRefreshing(true);
    setError(null);
    try {
      const client = await transport.ensureClient();
      const { workspaces: available, activeWorkspaceId: active } = await prepareWorkspaceContext(
        client,
        identity.publicKey,
        activeCommunityId ?? undefined,
      );
      setCommunities(available);
      setActiveCommunityId(active);
      setDisplayChannels(await loadDisplayChannels(transport, active, available));
    } catch (err) {
      setError(String(err));
    } finally {
      setRefreshing(false);
    }
  }, [activeCommunityId, identity, transport]);

  // A newly-created Workspace is already relay-backed, but device Back can reveal
  // an older mounted home screen. Refresh on focus so its switcher is never stale.
  useFocusEffect(
    useCallback(() => {
      if (!transport || !identity) return;
      void handleRefresh();
    }, [handleRefresh, identity, transport]),
  );

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
      setError(`Could not create ${ROOM_LABEL}: ${String(err)}`);
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
      const { workspaces: available, activeWorkspaceId: active } = await prepareWorkspaceContext(
        client,
        identity.publicKey,
        activeCommunityId ?? undefined,
      );
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

  const handleInvitePeople = useCallback(async () => {
    if (!transport || !activeCommunityId || creatingInvite) return;
    setCreatingInvite(true);
    setError(null);
    try {
      const client = await transport.ensureClient();
      setReadyInviteUrl(await createCommunityInviteUrl(client, activeCommunityId));
    } catch (err) {
      setError(`Could not create invite: ${String(err)}`);
    } finally {
      setCreatingInvite(false);
    }
  }, [activeCommunityId, creatingInvite, transport]);

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
          <CommunityDrawerTrigger community={activeCommunity} />
          <View style={styles.headerIdentity}>
            <Text style={styles.headerTitle} numberOfLines={1}>
              {activeCommunity?.name ?? WORKSPACE_LABEL}
            </Text>
          </View>
          <View style={styles.headerActions}>
            {activeCommunityId && (
              <TouchableOpacity
                accessibilityLabel={`${WORKSPACE_LABEL} Agents`}
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
                accessibilityLabel={`Create ${ROOM_LABEL}`}
                onPress={() => setShowCreateChannel((value) => !value)}
                style={styles.iconButton}
              >
                <Text style={styles.iconButtonText}>＋</Text>
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

        {readyInviteUrl && (
          <View style={styles.invitePanel}>
            <Text style={styles.panelTitle}>Invite link ready</Text>
            <Text style={styles.inviteUrl} numberOfLines={2}>
              {readyInviteUrl}
            </Text>
            <View style={styles.panelActions}>
              <TouchableOpacity
                style={styles.secondarySmallButton}
                accessibilityLabel={`Share ${WORKSPACE_LABEL} invite`}
                onPress={() => Share.share({ message: readyInviteUrl })}
              >
                <Text style={styles.secondarySmallButtonText}>Share</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.secondarySmallButton}
                accessibilityLabel={`Copy ${WORKSPACE_LABEL} invite link`}
                onPress={() => Clipboard.setStringAsync(readyInviteUrl)}
              >
                <Text style={styles.secondarySmallButtonText}>Copy link</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        {showCreateChannel && !viewerIsAgent && (
          <View style={styles.actionPanel}>
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
          </View>
        )}

        {showSettings && (
          <View style={styles.actionPanel}>
            <Text style={styles.panelTitle}>Settings</Text>
            <TouchableOpacity
              accessibilityLabel="Open identity and backup settings"
              onPress={() => router.push('/buzz/settings/identity' as Href)}
              style={styles.identitySettingsRow}
            >
              <View style={styles.identitySettingsCopy}>
                <Text style={styles.identitySettingsTitle}>Back up your key</Text>
                <Text style={styles.identitySettingsSubtitle}>Export your secret key</Text>
              </View>
              <Text style={styles.identitySettingsChevron}>›</Text>
            </TouchableOpacity>
            <Text style={styles.fieldLabel}>Relay URL</Text>
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
                <Text style={styles.primarySmallButtonText}>Save</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.secondarySmallButton} onPress={handleLogout}>
                <Text style={styles.secondarySmallButtonText}>Forget key</Text>
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
              <Text style={styles.retryText}>Retry</Text>
            </TouchableOpacity>
          </View>
        )}

        <FlatList
          data={displayChannels}
          keyExtractor={(item) => item.id}
          contentContainerStyle={
            displayChannels.length === 0 ? styles.emptyContainer : styles.listContent
          }
          ListHeaderComponent={
            displayChannels.length > 0 ? (
              <CommunityInviteEntry
                community={activeCommunity}
                creatingInvite={creatingInvite}
                onInvitePeople={() => void handleInvitePeople()}
                onManageAgents={() =>
                  activeCommunityId &&
                  router.push(
                    `/buzz/agents?communityId=${encodeURIComponent(activeCommunityId)}` as Href,
                  )
                }
              />
            ) : null
          }
          ListEmptyComponent={
            <View style={styles.emptyState}>
              <Text style={styles.emptyGlyph}>⌁</Text>
              <Text style={styles.emptyTitle}>No {ROOMS_LABEL.toLowerCase()} yet</Text>
              <Text style={styles.emptySubtitle}>
                {activeCommunity
                  ? `Start a focused place for steering and review.`
                  : `${WORKSPACE_LABEL} setup is still finishing.`}
              </Text>
              {!viewerIsAgent && !showCreateChannel && !showSettings && (
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
                onInvitePeople={() => void handleInvitePeople()}
                onManageAgents={() =>
                  activeCommunityId &&
                  router.push(
                    `/buzz/agents?communityId=${encodeURIComponent(activeCommunityId)}` as Href,
                  )
                }
              />
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
                    {item.title ?? `${ROOM_LABEL.toLowerCase()} ${item.id.slice(0, 8)}`}
                  </Text>
                  {item.archived && <Text style={styles.metaTag}>archived</Text>}
                </View>
                <Text style={styles.channelMeta}>
                  {item.id.slice(0, 10)}
                  {item.subchannelCount
                    ? ` · ${item.subchannelCount} ${
                        item.subchannelCount === 1 ? CHANGE_LABEL : 'changes'
                      }`
                    : ''}
                  {item.isSubchannel ? ` · agent ${shortPubkey(item.openerPubkey)}` : ''}
                  {item.isSubchannel ? (item.archived ? ' · closed' : ' · live') : ''}
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
  loadingText: { ...Typography.default(), marginTop: 12, color: groknight.muted, fontSize: 13 },
  header: {
    minHeight: 58,
    paddingHorizontal: 12,
    paddingVertical: 7,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: groknight.bgBase,
    borderBottomWidth: 1,
    borderBottomColor: groknight.border,
  },
  headerIdentity: { flex: 1, minWidth: 0 },
  headerTitle: {
    ...Typography.default('semiBold'),
    color: groknight.textPrimary,
    fontSize: 17,
    fontWeight: '700',
  },
  headerActions: { flexDirection: 'row', gap: 2, marginLeft: 8 },
  iconButton: {
    minWidth: 34,
    height: 34,
    paddingHorizontal: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconButtonText: { ...Typography.default(), color: groknight.steel, fontSize: 17 },
  actionPanel: {
    paddingHorizontal: 16,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: groknight.border,
    backgroundColor: groknight.bgTerminal,
  },
  identitySettingsRow: {
    minHeight: 52,
    marginBottom: 16,
    paddingVertical: 8,
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: 1,
    borderBottomColor: groknight.border,
  },
  identitySettingsCopy: { flex: 1, minWidth: 0 },
  identitySettingsTitle: {
    ...Typography.default('semiBold'),
    color: groknight.textPrimary,
    fontSize: 13,
    fontWeight: '700',
  },
  identitySettingsSubtitle: {
    ...Typography.default(),
    marginTop: 3,
    color: groknight.muted,
    fontSize: 11,
  },
  identitySettingsChevron: {
    ...Typography.default(),
    marginLeft: 8,
    color: groknight.chrome,
    fontSize: 22,
  },
  invitePanel: {
    paddingHorizontal: 16,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: groknight.border,
    backgroundColor: groknight.bgTerminal,
  },
  panelTitle: {
    ...Typography.default('semiBold'),
    marginBottom: 9,
    color: groknight.textPrimary,
    fontSize: 15,
    fontWeight: '700',
  },
  fieldLabel: {
    ...Typography.default('semiBold'),
    marginBottom: 7,
    color: groknight.textSecondary,
    fontSize: 12,
    fontWeight: '600',
  },
  inviteUrl: { ...Typography.default(), color: groknight.muted, fontSize: 11, lineHeight: 16 },
  inlineForm: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  input: {
    ...Typography.default(),
    flex: 1,
    minWidth: 0,
    minHeight: 40,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: groknight.borderActive,
    color: groknight.textPrimary,
    backgroundColor: groknight.bgBase,
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
    ...Typography.default('semiBold'),
    color: groknight.bgTerminal,
    fontWeight: '700',
    fontSize: 13,
  },
  secondarySmallButton: {
    minHeight: 36,
    paddingHorizontal: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondarySmallButtonText: {
    ...Typography.default('semiBold'),
    color: groknight.textSecondary,
    fontSize: 12,
    fontWeight: '600',
  },
  disabled: { opacity: 0.45 },
  errorPanel: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    backgroundColor: groknight.bgHighlight,
    borderBottomWidth: 1,
    borderBottomColor: groknight.borderActive,
  },
  errorText: { ...Typography.default(), color: groknight.chrome, fontSize: 11, lineHeight: 16 },
  retryText: {
    ...Typography.default('semiBold'),
    marginTop: 5,
    color: groknight.textSecondary,
    fontSize: 11,
    fontWeight: '700',
  },
  listContent: { paddingVertical: 4 },
  channelItem: {
    minHeight: 64,
    paddingHorizontal: 16,
    paddingVertical: 12,
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: 1,
    borderBottomColor: groknight.border,
  },
  subchannelItem: { paddingLeft: 25, backgroundColor: groknight.bgBase },
  channelIcon: {
    ...Typography.default('semiBold'),
    width: 25,
    color: groknight.steel,
    fontSize: 15,
    fontWeight: '700',
  },
  channelInfo: { flex: 1, minWidth: 0 },
  channelTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  channelTitle: {
    ...Typography.default('semiBold'),
    flexShrink: 1,
    color: groknight.textPrimary,
    fontSize: 14,
    fontWeight: '700',
  },
  subchannelTitle: { ...Typography.default(), color: groknight.textSecondary, fontSize: 13 },
  archivedTitle: { color: groknight.muted },
  metaTag: {
    ...Typography.default(),
    paddingHorizontal: 5,
    paddingVertical: 2,
    color: groknight.steel,
    backgroundColor: groknight.bgHighlight,
    borderRadius: 3,
    fontSize: 9,
  },
  channelMeta: {
    ...Typography.default(),
    marginTop: 4,
    color: groknight.dim,
    fontSize: 9,
  },
  chevron: { ...Typography.default(), marginLeft: 8, color: groknight.gutter, fontSize: 22 },
  emptyContainer: { flexGrow: 1 },
  emptyState: { flex: 1, paddingHorizontal: 22, alignItems: 'center', justifyContent: 'center' },
  emptyGlyph: {
    ...Typography.default(),
    width: 44,
    height: 44,
    borderWidth: 1,
    borderColor: groknight.borderActive,
    borderRadius: 12,
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
    fontWeight: '800',
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
    minHeight: 42,
    paddingHorizontal: 18,
    borderRadius: 4,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: groknight.accent,
  },
  primaryButtonText: {
    ...Typography.default('semiBold'),
    color: groknight.bgTerminal,
    fontWeight: '700',
    fontSize: 13,
  },
});
