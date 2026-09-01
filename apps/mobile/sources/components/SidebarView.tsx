import * as React from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { type Href, usePathname, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet } from 'react-native-unistyles';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { type ChatListView } from '@beeline/buzz-client';
import { RoomViewClient } from '@/sync/transport/room-view-client';
import { getEffectiveRelayUrl, loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import { useHeaderHeight } from '@/utils/responsive';
import { ROOM_LABEL, ROOMS_LABEL } from '@/buzz/vocabulary';
import { HullDeckMark } from '@/components/buzz/MonoHull';

function selectedRoomId(pathname: string): string | null {
  const prefix = '/buzz/chat/';
  if (!pathname.startsWith(prefix)) return null;
  try {
    return decodeURIComponent(pathname.slice(prefix.length).split('/')[0]!);
  } catch {
    return pathname.slice(prefix.length).split('/')[0] ?? null;
  }
}

const stylesheet = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderRightColor: theme.colors.divider,
    backgroundColor: theme.colors.groupped.background,
  },
  topControls: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.divider,
  },
  heading: {
    color: theme.colors.text,
    fontSize: 13,
    fontFamily: 'IBMPlexMono-SemiBold',
    letterSpacing: 1.2,
  },
  homeButton: { padding: 6 },
  list: { flex: 1 },
  listContent: { paddingVertical: 8 },
  roomRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    minHeight: 48,
    marginHorizontal: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 8,
  },
  roomRowSelected: { backgroundColor: theme.colors.surfaceSelected },
  roomCopy: { flex: 1, minWidth: 0 },
  roomTitle: { color: theme.colors.text, fontSize: 13, fontFamily: 'IBMPlexSans-Regular' },
  roomTitleUnread: { fontFamily: 'IBMPlexSans-SemiBold' },
  roomFact: {
    marginTop: 2,
    color: theme.colors.textSecondary,
    fontSize: 11,
    fontFamily: 'IBMPlexMono-Regular',
  },
  empty: {
    paddingHorizontal: 18,
    paddingVertical: 24,
    color: theme.colors.textSecondary,
    fontSize: 12,
    fontFamily: 'IBMPlexMono-Regular',
    lineHeight: 18,
  },
  settingsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.divider,
  },
  settingsText: {
    color: theme.colors.text,
    fontSize: 13,
    fontFamily: 'IBMPlexMono-SemiBold',
    letterSpacing: 0.5,
  },
}));

/** Persistent tablet navigation reads server paint rows directly and holds no global cache. */
export const SidebarView = React.memo(function SidebarView() {
  const styles = stylesheet;
  const safeArea = useSafeAreaInsets();
  const headerHeight = useHeaderHeight();
  const router = useRouter();
  const pathname = usePathname();
  const activeRoomId = selectedRoomId(pathname);
  const [surface, setSurface] = React.useState<ChatListView | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      const identity = await loadBuzzIdentity();
      if (!identity) return;
      const relayUrl = await getEffectiveRelayUrl();
      const http = new RoomViewClient({ baseUrl: relayUrl, identity });
      const workspaces = await http.workspaces();
      const workspaceId = workspaces.workspaces[0]?.id;
      if (!workspaceId) return;
      const chats = await http.chats(workspaceId);
      if (!cancelled) setSurface(chats);
    })().catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [pathname]);

  return (
    <View style={[styles.container, { paddingTop: safeArea.top + headerHeight }]}>
      <View style={styles.topControls}>
        <Text style={styles.heading}>{ROOMS_LABEL.toUpperCase()}</Text>
        <Pressable
          accessibilityLabel={`Open ${ROOMS_LABEL}`}
          accessibilityRole="button"
          hitSlop={8}
          onPress={() => router.navigate('/buzz/channels')}
          style={styles.homeButton}
        >
          <Ionicons name="grid-outline" size={17} color={stylesheet.heading.color} />
        </Pressable>
      </View>
      <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
        {!surface?.chats.length ? (
          <Text style={styles.empty}>
            Your {ROOMS_LABEL} will appear here after the workspace connects.
          </Text>
        ) : (
          surface.chats.map((item) => (
            <Pressable
              key={item.room.id}
              accessibilityLabel={`Open ${ROOM_LABEL} ${item.room.name}`}
              accessibilityRole="button"
              onPress={() => router.push(`/buzz/chat/${encodeURIComponent(item.room.id)}` as Href)}
              style={({ pressed }) => [
                styles.roomRow,
                activeRoomId === item.room.id && styles.roomRowSelected,
                pressed && styles.roomRowSelected,
              ]}
            >
              <HullDeckMark state="idle" />
              <View style={styles.roomCopy}>
                <Text
                  numberOfLines={1}
                  style={[styles.roomTitle, item.unread && styles.roomTitleUnread]}
                >
                  {item.room.name}
                </Text>
                <Text numberOfLines={1} style={styles.roomFact}>
                  {item.latestMessage?.text ?? 'No activity yet'}
                </Text>
              </View>
            </Pressable>
          ))
        )}
      </ScrollView>
      <Pressable
        accessibilityLabel="Open Beeline settings"
        accessibilityRole="button"
        onPress={() => router.push('/buzz/settings' as Href)}
        style={styles.settingsRow}
      >
        <Ionicons name="settings-outline" size={18} color={stylesheet.settingsText.color} />
        <Text style={styles.settingsText}>SETTINGS</Text>
      </Pressable>
    </View>
  );
});
