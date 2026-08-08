/**
 * Buzz Channel List — shows the user's channels (sessionsRead).
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

export default function BuzzChannels() {
  const insets = useSafeAreaInsets();
  const [transport, setTransport] = useState<RigTransport | null>(null);
  const [channels, setChannels] = useState<SessionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
        const list = await t.sessionsRead();
        if (!cancelled) {
          setChannels(list);
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
    (channel: SessionSummary) => {
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
      setChannels(list);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [transport]);

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
        data={channels}
        keyExtractor={(item) => item.id}
        contentContainerStyle={channels.length === 0 ? styles.emptyContainer : undefined}
        ListEmptyComponent={
          <View style={styles.emptyState}>
            <Text style={styles.emptyTitle}>No channels yet</Text>
            <Text style={styles.emptySubtitle}>
              Create a channel out-of-band using the buzz-client CLI or script,
              then pull to refresh.
            </Text>
          </View>
        }
        renderItem={({ item }) => (
          <TouchableOpacity
            style={styles.channelItem}
            onPress={() => handleChannelPress(item)}
          >
            <View style={styles.channelInfo}>
              <Text style={styles.channelTitle}>
                {item.title ?? `Channel ${item.id.slice(0, 8)}`}
              </Text>
              <Text style={styles.channelId}>{item.id.slice(0, 8)}…</Text>
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
  channelInfo: {
    flex: 1,
  },
  channelTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#fff',
    marginBottom: 2,
  },
  channelId: {
    fontSize: 12,
    color: '#666',
    fontFamily: 'monospace',
  },
  chevron: {
    fontSize: 22,
    color: '#555',
    marginLeft: 8,
  },
});