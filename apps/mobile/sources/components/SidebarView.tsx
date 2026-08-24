import * as React from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { type Href, usePathname, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet } from 'react-native-unistyles';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useHeaderHeight } from '@/utils/responsive';
import { selectChannelList, useBuzzLocalCache } from '@/buzz/local-cache';
import { roomListFeed } from '@/buzz/room-list-row';
import { isRoomUnread, roomReadAt, useRoomReadState } from '@/buzz/room-read-state';
import { ROOM_LABEL, ROOMS_LABEL } from '@/buzz/vocabulary';
import { HullDeckMark } from '@/components/buzz/MonoHull';

function selectedRoomId(pathname: string): string | null {
  const prefix = '/buzz/chat/';
  if (!pathname.startsWith(prefix)) return null;
  const encoded = pathname.slice(prefix.length).split('/')[0];
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
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
  homeButton: {
    padding: 6,
  },
  list: {
    flex: 1,
  },
  listContent: {
    paddingVertical: 8,
  },
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
  roomRowSelected: {
    backgroundColor: theme.colors.surfaceSelected,
  },
  roomCopy: {
    flex: 1,
    minWidth: 0,
  },
  roomTitle: {
    color: theme.colors.text,
    fontSize: 13,
    fontFamily: 'IBMPlexSans-Regular',
  },
  roomTitleUnread: {
    fontFamily: 'IBMPlexSans-SemiBold',
  },
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

/** Persistent tablet/desktop navigation for the Beeline surface. */
export const SidebarView = React.memo(function SidebarView() {
  const styles = stylesheet;
  const safeArea = useSafeAreaInsets();
  const headerHeight = useHeaderHeight();
  const router = useRouter();
  const pathname = usePathname();
  const activeRoomId = selectedRoomId(pathname);
  const cachedList = useBuzzLocalCache((state) =>
    selectChannelList(state, state.activeViewerPubkey),
  );
  const readAt = useRoomReadState((state) => state.readAt);
  const viewerPubkey = useBuzzLocalCache((state) => state.activeViewerPubkey);
  const authorNames = React.useMemo(
    () =>
      new Map(
        (cachedList?.workspaceMembers ?? []).map((member) => [member.peerPubkey, member.peerName]),
      ),
    [cachedList?.workspaceMembers],
  );
  const feed = React.useMemo(
    () =>
      roomListFeed(
        (cachedList?.channels ?? []).map((room) => ({
          ...room,
          // Same unread activity channel as the phone feed: bold and
          // recent, never a state-circle override.
          roomUnread: isRoomUnread(
            roomReadAt(readAt, viewerPubkey ?? undefined, room.id),
            room.latestMessageAt,
          ),
        })),
        authorNames,
      ),
    [authorNames, cachedList?.channels, readAt, viewerPubkey],
  );

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
        {feed.length === 0 ? (
          <Text style={styles.empty}>
            Your {ROOMS_LABEL} will appear here after the workspace connects.
          </Text>
        ) : (
          feed.map(({ item, row }) => (
            <Pressable
              key={item.id}
              accessibilityLabel={`Open ${ROOM_LABEL} ${item.title ?? item.id}`}
              accessibilityRole="button"
              onPress={() => router.push(`/buzz/chat/${encodeURIComponent(item.id)}` as Href)}
              style={({ pressed }) => [
                styles.roomRow,
                activeRoomId === item.id && styles.roomRowSelected,
                pressed && styles.roomRowSelected,
              ]}
            >
              <HullDeckMark state={row.state} />
              <View style={styles.roomCopy}>
                <Text
                  numberOfLines={1}
                  style={[styles.roomTitle, row.unread && styles.roomTitleUnread]}
                >
                  {item.title ?? `${ROOM_LABEL} ${item.id.slice(0, 8)}`}
                </Text>
                <Text numberOfLines={1} style={styles.roomFact}>
                  {row.fact}
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
