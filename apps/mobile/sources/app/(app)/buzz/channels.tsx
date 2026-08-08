/**
 * Buzz Channel List — shows the user's channels (sessionsRead).
 *
 * P2: Distinguishes subchannels (shown indented under parent), archived status,
 *     and subchannel counts per parent.
 *
 * On mount, loads existing identity from storage, creates a BuzzRigTransport,
 * and calls sessionsRead. Tapping a channel navigates to the chat screen.
 */
import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { loadBuzzIdentity, clearBuzzIdentity } from '@/auth/buzz-identity-storage';
import { BuzzRigTransport } from '@/sync/transport';
import type { SessionSummary, RigTransport } from '@/sync/transport';

type ChannelDisplayItem = SessionSummary & {
  isSubchannel?: boolean;
  parentChannelId?: string;
  subchannelCount?: number;
  archived?: boolean;
};

export default function BuzzChannels() {
  const insets = useSafeAreaInsets();
  const [transport, setTransport] = useState<RigTransport | null>(null);
  const [displayChannels, setDisplayChannels] = useState<ChannelDisplayItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [buzzTransport, setBuzzTransport] = useState<BuzzRigTransport | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const identity = await loadBuzzIdentity();
        if (!identity) {
          router.replace('/buzz/onboarding');
          return;
        }
        const t = new BuzzRigTransport(identity);
        setTransport(t);
        setBuzzTransport(t);

        const list = await t.sessionsRead();

        // P2: Enrich channels with subchannel info
        const enriched: ChannelDisplayItem[] = [];
        const parentItems: ChannelDisplayItem[] = [];

        for (const ch of list) {
          // Check if this is a subchannel (has parentChannelId)
          try {
            const detail = await t.sessionRead(ch.id);
            const isParent = detail?.channelId ? false : true;
            const archived = detail?.active === false;

            if (detail?.channelId) {
              // This is a subchannel
              enriched.push({
                ...ch,
                isSubchannel: true,
                parentChannelId: detail.channelId,
                archived,
              });
            } else {
              parentItems.push({ ...ch, archived });
            }
          } catch {
            parentItems.push({ ...ch });
          }
        }

        // P2: For each parent, find their subchannels
        if ('listSubchannels' in t && typeof (t as BuzzRigTransport).listSubchannels === 'function') {
          for (const parent of parentItems) {
            try {
              const subIds = await (t as BuzzRigTransport).listSubchannels(parent.id);
              parent.subchannelCount = subIds.length;
            } catch {
              // Ignore — not all channels support subchannel listing
            }
          }
        }

        // Combine: parents first, then subchannels grouped under them
        const grouped: ChannelDisplayItem[] = [...parentItems];
        // Add subchannels after each parent
        for (const parent of parentItems) {
          const children = enriched.filter((ch) => ch.parentChannelId === parent.id);
          if (children.length > 0) {
            grouped.push(...children);
          }
        }
        // Add orphan subchannels (parent not in list)
        const orphanSubs = enriched.filter(
          (ch) => !parentItems.some((p) => p.id === ch.parentChannelId),
        );
        grouped.push(...orphanSubs);

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
    if (!transport) return;
    setLoading(true);
    setError(null);
    try {
      const list = await transport.sessionsRead();
      const enriched: ChannelDisplayItem[] = [];
      const parentItems: ChannelDisplayItem[] = [];

      for (const ch of list) {
        try {
          const detail = await transport.sessionRead(ch.id);
          if (detail?.channelId) {
            enriched.push({
              ...ch,
              isSubchannel: true,
              parentChannelId: detail.channelId,
              archived: detail.active === false,
            });
          } else {
            parentItems.push({ ...ch, archived: detail?.active === false });
          }
        } catch {
          parentItems.push({ ...ch });
        }
      }

      if (buzzTransport && 'listSubchannels' in buzzTransport) {
        for (const parent of parentItems) {
          try {
            const subIds = await buzzTransport.listSubchannels(parent.id);
            parent.subchannelCount = subIds.length;
          } catch {
            // ignore
          }
        }
      }

      const grouped: ChannelDisplayItem[] = [...parentItems];
      for (const parent of parentItems) {
        const children = enriched.filter((ch) => ch.parentChannelId === parent.id);
        if (children.length > 0) grouped.push(...children);
      }
      const orphanSubs = enriched.filter(
        (ch) => !parentItems.some((p) => p.id === ch.parentChannelId),
      );
      grouped.push(...orphanSubs);

      setDisplayChannels(grouped);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [transport, buzzTransport]);

  if (loading) {
    return (
      <View style={[styles.container, styles.center, { paddingTop: insets.top }]}>
        <ActivityIndicator size="large" color="#0a84ff" />
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
        <Text style={styles.headerTitle}>My Channels</Text>
        <TouchableOpacity onPress={handleLogout}>
          <Text style={styles.logoutText}>Logout</Text>
        </TouchableOpacity>
      </View>

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
                  {item.archived ? '📦' : item.isSubchannel ? '🛠' : '💬'}
                </Text>
                <Text
                  style={[
                    styles.channelTitle,
                    item.isSubchannel && styles.subchannelTitle,
                    item.archived && styles.archivedTitle,
                  ]}
                  numberOfLines={1}
                >
                  {item.title ?? `Channel ${item.id.slice(0, 8)}`}
                </Text>
                {item.archived && (
                  <Text style={styles.archivedTag}>archived</Text>
                )}
              </View>
              <Text style={styles.channelId}>
                {item.isSubchannel ? '  subchannel' : ''} {item.id.slice(0, 8)}…
              </Text>
              {item.subchannelCount !== undefined && item.subchannelCount > 0 && (
                <Text style={styles.subchannelCount}>
                  {item.subchannelCount} subchannel{item.subchannelCount !== 1 ? 's' : ''}
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
    backgroundColor: '#000',
  },
  center: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#222',
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: '#fff',
  },
  logoutText: {
    fontSize: 14,
    color: '#ff453a',
  },
  loadingText: {
    marginTop: 12,
    fontSize: 14,
    color: '#888',
  },
  errorText: {
    fontSize: 14,
    color: '#ff453a',
    marginBottom: 16,
    textAlign: 'center',
    paddingHorizontal: 24,
  },
  retryButton: {
    backgroundColor: '#0a84ff',
    paddingVertical: 10,
    paddingHorizontal: 24,
    borderRadius: 8,
    marginBottom: 12,
  },
  retryButtonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  logoutButton: {
    paddingVertical: 10,
    paddingHorizontal: 24,
  },
  logoutButtonText: {
    color: '#ff453a',
    fontSize: 14,
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
    color: '#fff',
    marginBottom: 8,
  },
  emptySubtitle: {
    fontSize: 14,
    color: '#888',
    textAlign: 'center',
    lineHeight: 20,
  },
  channelItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#1a1a1a',
  },
  subchannelItem: {
    paddingLeft: 40,
    backgroundColor: '#0a0a0f',
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
    fontSize: 14,
    marginRight: 6,
  },
  channelTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#fff',
    flex: 1,
  },
  subchannelTitle: {
    fontSize: 14,
    color: '#8af',
  },
  archivedTitle: {
    color: '#888',
    textDecorationLine: 'line-through',
  },
  archivedTag: {
    fontSize: 10,
    color: '#888',
    backgroundColor: '#333',
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 1,
    marginLeft: 6,
  },
  channelId: {
    fontSize: 12,
    color: '#666',
    fontFamily: 'monospace',
  },
  subchannelCount: {
    fontSize: 11,
    color: '#0a84ff',
    marginTop: 2,
  },
  chevron: {
    fontSize: 22,
    color: '#555',
    marginLeft: 8,
  },
});