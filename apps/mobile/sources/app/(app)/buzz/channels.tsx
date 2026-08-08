/**
 * Buzz Channel List — shows the user's channels (sessionsRead).
 *
 * P2: Distinguishes subchannels (shown indented under parent), archived status,
 *     and subchannel counts per parent.
 *
 * GrokNight Terminal design.
 */
import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  FlatList,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Platform,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { loadBuzzIdentity, clearBuzzIdentity, getEffectiveRelayUrl, saveRelayUrl } from '@/auth/buzz-identity-storage';
import { BuzzRigTransport } from '@/sync/transport';
import type { SessionSummary, RigTransport } from '@/sync/transport';
import { groknight } from '@/buzz/groknight';

type ChannelDisplayItem = SessionSummary & {
  isSubchannel?: boolean;
  parentChannelId?: string;
  subchannelCount?: number;
  archived?: boolean;
};

const mono = Platform.select({ web: '"JetBrains Mono", monospace', default: 'monospace' });

export default function BuzzChannels() {
  const insets = useSafeAreaInsets();
  const [transport, setTransport] = useState<RigTransport | null>(null);
  const [displayChannels, setDisplayChannels] = useState<ChannelDisplayItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [buzzTransport, setBuzzTransport] = useState<BuzzRigTransport | null>(null);
  const [relayUrl, setRelayUrl] = useState('https://buzz.trustysquire.ai');
  const [showSettings, setShowSettings] = useState(false);
  const [settingsRelayUrl, setSettingsRelayUrl] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const identity = await loadBuzzIdentity();
        if (!identity) {
          router.replace('/buzz/onboarding');
          return;
        }
        const url = await getEffectiveRelayUrl();
        setRelayUrl(url);
        const t = new BuzzRigTransport(identity, url);
        setTransport(t);
        setBuzzTransport(t);

        const list = await t.sessionsRead();

        // P2: Enrich channels with subchannel info.
        const parentIds = new Set<string>();
        const childMap = new Map<string, ChannelDisplayItem[]>();
        const allItems: ChannelDisplayItem[] = [];

        for (const ch of list) {
          try {
            const parentId = await (t as BuzzRigTransport).getParentChannelId(ch.id);
            if (parentId) {
              const item: ChannelDisplayItem = { ...ch, isSubchannel: true, parentChannelId: parentId };
              allItems.push(item);
              const siblings = childMap.get(parentId) ?? [];
              siblings.push(item);
              childMap.set(parentId, siblings);
            } else {
              allItems.push({ ...ch });
              parentIds.add(ch.id);
            }
          } catch {
            allItems.push({ ...ch });
          }
        }

        if ('listSubchannels' in t && typeof (t as BuzzRigTransport).listSubchannels === 'function') {
          for (const pid of parentIds) {
            try {
              const subIds = await (t as BuzzRigTransport).listSubchannels(pid);
              const displayItem = allItems.find((item) => item.id === pid);
              if (displayItem) {
                displayItem.subchannelCount = subIds.length;
              }
            } catch {
              // Ignore
            }
          }
        }

        // Combine: parents first, then subchannels grouped under each parent.
        const grouped: ChannelDisplayItem[] = [];
        for (const item of allItems) {
          if (!item.isSubchannel) {
            grouped.push(item);
            const children = item.id ? childMap.get(item.id) : undefined;
            if (children && children.length > 0) {
              grouped.push(...children);
            }
          }
        }
        for (const item of allItems) {
          if (item.isSubchannel && !grouped.includes(item)) {
            grouped.push(item);
          }
        }

        if (!cancelled) {
          setDisplayChannels(grouped);
        }
      } catch (err) {
        if (!cancelled) {
          setError(String(err));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleChannelPress = useCallback(
    (channel: ChannelDisplayItem) => {
      router.push(`/buzz/chat/${encodeURIComponent(channel.id)}`);
    },
    [],
  );

  const handleLogout = useCallback(async () => {
    await clearBuzzIdentity();
    router.replace('/buzz/onboarding');
  }, []);

  const handleRefresh = useCallback(async () => {
    if (!transport || !buzzTransport) return;
    setLoading(true);
    setError(null);
    try {
      const list = await transport.sessionsRead();

      const parentIds = new Set<string>();
      const childMap = new Map<string, ChannelDisplayItem[]>();
      const allItems: ChannelDisplayItem[] = [];

      for (const ch of list) {
        try {
          const parentId = await buzzTransport.getParentChannelId(ch.id);
          if (parentId) {
            const item: ChannelDisplayItem = { ...ch, isSubchannel: true, parentChannelId: parentId };
            allItems.push(item);
            const siblings = childMap.get(parentId) ?? [];
            siblings.push(item);
            childMap.set(parentId, siblings);
          } else {
            allItems.push({ ...ch });
            parentIds.add(ch.id);
          }
        } catch {
          allItems.push({ ...ch });
        }
      }

      for (const pid of parentIds) {
        try {
          const subIds = await buzzTransport.listSubchannels(pid);
          const displayItem = allItems.find((item) => item.id === pid);
          if (displayItem) {
            displayItem.subchannelCount = subIds.length;
          }
        } catch {
          // ignore
        }
      }

      const grouped: ChannelDisplayItem[] = [];
      for (const item of allItems) {
        if (!item.isSubchannel) {
          grouped.push(item);
          const children = item.id ? childMap.get(item.id) : undefined;
          if (children && children.length > 0) {
            grouped.push(...children);
          }
        }
      }
      for (const item of allItems) {
        if (item.isSubchannel && !grouped.includes(item)) {
          grouped.push(item);
        }
      }

      setDisplayChannels(grouped);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [transport, buzzTransport]);

  const handleSaveRelayUrl = useCallback(async () => {
    const url = settingsRelayUrl.trim() || 'https://buzz.trustysquire.ai';
    await saveRelayUrl(url);
    setRelayUrl(url);
    setShowSettings(false);
    // Reconnect by refreshing
    handleRefresh();
  }, [settingsRelayUrl, handleRefresh]);

  const openSettings = useCallback(() => {
    setSettingsRelayUrl(relayUrl);
    setShowSettings(true);
  }, [relayUrl]);

  if (loading) {
    return (
      <View style={[styles.container, styles.center, { paddingTop: insets.top }]}>
        <ActivityIndicator size="large" color={groknight.magenta} />
        <Text style={styles.loadingText}>Connecting to relay…</Text>
      </View>
    );
  }

  if (error) {
    return (
      <View style={[styles.container, styles.center, { paddingTop: insets.top }]}>
        <Text style={styles.errorText}>Error: {error}</Text>
        <TouchableOpacity style={styles.retryButton} onPress={handleRefresh}>
          <Text style={styles.retryButtonText}>Retry</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.logoutButton} onPress={handleLogout}>
          <Text style={styles.logoutButtonText}>Logout</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>channels</Text>
        <View style={styles.headerActions}>
          <TouchableOpacity onPress={openSettings} style={styles.settingsButton}>
            <Text style={styles.settingsIcon}>⚙</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={handleLogout}>
            <Text style={styles.logoutText}>logout</Text>
          </TouchableOpacity>
        </View>
      </View>

      {showSettings && (
        <View style={styles.settingsPanel}>
          <Text style={styles.settingsLabel}>Relay URL</Text>
          <TextInput
            style={styles.settingsInput}
            value={settingsRelayUrl}
            onChangeText={setSettingsRelayUrl}
            placeholder="https://buzz.trustysquire.ai"
            placeholderTextColor={groknight.dim}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
          />
          <View style={styles.settingsActions}>
            <TouchableOpacity
              style={styles.settingsSaveButton}
              onPress={handleSaveRelayUrl}
            >
              <Text style={styles.settingsSaveText}>Save</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.settingsCancelButton}
              onPress={() => setShowSettings(false)}
            >
              <Text style={styles.settingsCancelText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      <FlatList
        data={displayChannels}
        keyExtractor={(item: ChannelDisplayItem) => item.id}
        contentContainerStyle={displayChannels.length === 0 ? styles.emptyContainer : undefined}
        ListEmptyComponent={
          <View style={styles.emptyState}>
            <Text style={styles.emptyTitle}>No channels yet</Text>
            <Text style={styles.emptySubtitle}>
              Create a channel out-of-band using the buzz-client CLI or script,
              then pull to refresh.
            </Text>
          </View>
        }
        renderItem={({ item }: { item: ChannelDisplayItem }) => (
          <TouchableOpacity
            style={[
              styles.channelItem,
              item.isSubchannel && styles.subchannelItem,
            ]}
            onPress={() => handleChannelPress(item)}
          >
            <View style={styles.channelInfo}>
              <View style={styles.channelTitleRow}>
                <Text style={styles.channelIcon}>
                  {item.archived ? '📦' : item.isSubchannel ? '🛠' : '#'}
                </Text>
                <Text
                  style={[
                    styles.channelTitle,
                    item.isSubchannel && styles.subchannelTitle,
                    item.archived && styles.archivedTitle,
                  ]}
                  numberOfLines={1}
                >
                  {item.title ?? `channel ${item.id.slice(0, 8)}`}
                </Text>
                {item.archived && (
                  <Text style={styles.archivedTag}>archived</Text>
                )}
              </View>
              <Text style={styles.channelId}>
                {item.id.slice(0, 12)}…
              </Text>
              {item.subchannelCount !== undefined && item.subchannelCount > 0 && (
                <Text style={styles.subchannelCount}>
                  {item.subchannelCount} sub{item.subchannelCount !== 1 ? 's' : ''}
                </Text>
              )}
            </View>
            <Text style={styles.chevron}>›</Text>
          </TouchableOpacity>
        )}
        onRefresh={handleRefresh}
        refreshing={loading}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: groknight.bgTerminal,
  },
  center: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: groknight.border,
    backgroundColor: groknight.bgBase,
  },
  headerTitle: {
    fontSize: 16,
    fontWeight: '800',
    color: groknight.textPrimary,
    letterSpacing: 0.5,
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  settingsButton: {
    padding: 4,
  },
  settingsIcon: {
    fontSize: 18,
    color: groknight.magenta,
  },
  logoutText: {
    fontSize: 12,
    color: groknight.red,
    fontFamily: mono,
    letterSpacing: 0.3,
  },
  settingsPanel: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: groknight.border,
    backgroundColor: groknight.bgBase,
  },
  settingsLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: groknight.muted,
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: 6,
  },
  settingsInput: {
    borderWidth: 1,
    borderColor: groknight.border,
    borderRadius: 4,
    padding: 10,
    fontSize: 14,
    color: groknight.textPrimary,
    backgroundColor: groknight.bgTerminal,
    fontFamily: mono,
  },
  settingsActions: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 8,
  },
  settingsSaveButton: {
    backgroundColor: groknight.magenta,
    borderRadius: 4,
    paddingVertical: 8,
    paddingHorizontal: 16,
  },
  settingsSaveText: {
    color: groknight.bgTerminal,
    fontSize: 13,
    fontWeight: '600',
    fontFamily: mono,
  },
  settingsCancelButton: {
    paddingVertical: 8,
    paddingHorizontal: 16,
  },
  settingsCancelText: {
    color: groknight.muted,
    fontSize: 13,
    fontFamily: mono,
  },
  loadingText: {
    marginTop: 12,
    fontSize: 14,
    color: groknight.muted,
    fontFamily: mono,
  },
  errorText: {
    fontSize: 14,
    color: groknight.red,
    marginBottom: 16,
    textAlign: 'center',
    paddingHorizontal: 24,
    fontFamily: mono,
  },
  retryButton: {
    backgroundColor: groknight.bgHighlight,
    paddingVertical: 10,
    paddingHorizontal: 24,
    borderRadius: 4,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: groknight.border,
  },
  retryButtonText: {
    color: groknight.textSecondary,
    fontSize: 14,
    fontWeight: '600',
    fontFamily: mono,
  },
  logoutButton: {
    paddingVertical: 10,
    paddingHorizontal: 24,
  },
  logoutButtonText: {
    color: groknight.red,
    fontSize: 14,
    fontFamily: mono,
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
  },
  emptyState: {
    alignItems: 'center',
    paddingHorizontal: 32,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: groknight.textPrimary,
    marginBottom: 8,
    fontFamily: mono,
  },
  emptySubtitle: {
    fontSize: 13,
    color: groknight.muted,
    textAlign: 'center',
    lineHeight: 20,
    fontFamily: mono,
  },
  channelItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: groknight.border,
  },
  subchannelItem: {
    paddingLeft: 36,
    backgroundColor: groknight.bgTerminal,
  },
  channelInfo: {
    flex: 1,
  },
  channelTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 2,
  },
  channelIcon: {
    fontSize: 13,
    marginRight: 6,
    color: groknight.muted,
  },
  channelTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: groknight.textPrimary,
    flex: 1,
    fontFamily: mono,
  },
  subchannelTitle: {
    fontSize: 13,
    color: groknight.blue,
  },
  archivedTitle: {
    color: groknight.muted,
    textDecorationLine: 'line-through',
  },
  archivedTag: {
    fontSize: 9,
    color: groknight.muted,
    backgroundColor: groknight.bgHighlight,
    borderRadius: 3,
    paddingHorizontal: 5,
    paddingVertical: 1,
    marginLeft: 6,
    fontFamily: mono,
    letterSpacing: 0.5,
  },
  channelId: {
    fontSize: 11,
    color: groknight.dim,
    fontFamily: mono,
  },
  subchannelCount: {
    fontSize: 10,
    color: groknight.blue,
    marginTop: 2,
    fontFamily: mono,
  },
  chevron: {
    fontSize: 18,
    color: groknight.gutter,
    marginLeft: 8,
  },
});
