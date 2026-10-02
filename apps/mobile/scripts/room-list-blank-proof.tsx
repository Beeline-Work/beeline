// Native proof for the blank Room card: the channels.tsx Room list card tree
// (SectionList, Swipeable, card frame, ConversationRow, corner dropdown) with
// fixture Rooms, run in the Android dev client. To run it, point index.ts at
// this component with registerRootComponent; set BEFORE_FIX to drop the frame
// key and see the card go blank when a pinned Room moves into first place.
import React, { useMemo, useRef, useState } from 'react';
import { Pressable, SectionList, Text, TouchableOpacity, View } from 'react-native';
import { GestureHandlerRootView, Swipeable } from 'react-native-gesture-handler';
import { StyleSheet } from 'react-native-unistyles';
import type { ChatListItem } from '@beeline/buzz-client';
import { ConversationRow } from '@/components/buzz/ConversationRow';
import { DesktopRoomCorners } from '@/components/buzz/DesktopRoomCorners';
import { RoomListSectionHeader } from '@/components/buzz/RoomListSectionHeader';
import { roomListSections } from '@/buzz/room-list-row';
import { filterConversations, type RoomListFilter } from '@/buzz/room-list-preferences';
import { useCornerDropdowns } from '@/buzz/corner-dropdowns';

const ROW_HEIGHT = 64;
const BEFORE_FIX = false;
const states = ['waiting', 'working', 'working', 'review', 'working', 'working', 'review'] as const;
const cornerNames = [
  'Issues triage',
  'Message search guards',
  'Daemon OOM policy',
  'Squire session control',
  'Reviewer role contradictions',
  'Helper liveness lifecycle',
  'Release Corner',
];

function makeRoom(id: string, author: string, text: string, at: number, corners = 0): ChatListItem {
  return {
    room: { id, name: id, updatedAt: at },
    unread: false,
    cornerCount: corners,
    waitingCornerCount: 0,
    openCorners: states.slice(0, corners).map((state, i) => ({
      id: `${id}-c${i}`,
      name: cornerNames[i],
      state,
      mine: true,
    })),
    latestMessage: {
      text,
      createdAt: at,
      author: { pubkey: author, name: author, handle: author },
    },
  } as unknown as ChatListItem;
}

const base = Date.now() / 1000;
const initialRooms: ChatListItem[] = [
  makeRoom('obsidian', 'emberus', 'Pinned room with recent activity here', base - 60),
  makeRoom('trusty-squire', 'ruby', '**Mostly no. The report is out of date', base - 180, 1),
  makeRoom('beeline', 'niglet', '@beeline-app[bot] merged Drop workflows', base - 480, 7),
  ...Array.from({ length: 18 }, (_, i) =>
    makeRoom(`room-${i}`, 'bbc', `Message number ${i} in this room`, base - 600 - i * 300, i % 3),
  ),
];

export default function Harness() {
  const [chats, setChats] = useState(initialRooms);
  const [filter, setFilter] = useState<RoomListFilter>('pinned');
  const pinned = ['obsidian', 'trusty-squire', 'beeline'];
  const cornerDropdowns = useCornerDropdowns(chats);
  const [ageNow, setAgeNow] = useState(() => Date.now());
  const swipeableRefs = useRef<Map<string, Swipeable | null>>(new Map());
  const sections = useMemo(
    () => roomListSections(filterConversations(chats, '', filter, pinned)),
    [chats, filter],
  );
  const bump = (id: string) => {
    setChats((current) => {
      const target = current.find((c) => c.room.id === id)!;
      const now = Date.now() / 1000;
      const next = {
        ...target,
        latestMessage: {
          ...target.latestMessage!,
          text: `new activity ${Math.round(now)}`,
          createdAt: now,
        },
      } as ChatListItem;
      return [next, ...current.filter((c) => c.room.id !== id)];
    });
    setAgeNow(Date.now());
  };
  const button = (label: string, onPress: () => void) => (
    <Pressable key={label} onPress={onPress} style={styles.button} testID={`h-${label}`}>
      <Text style={styles.buttonText}>{label}</Text>
    </Pressable>
  );
  return (
    <GestureHandlerRootView style={styles.container}>
      <View style={styles.controls}>
        {button('all', () => setFilter('all'))}
        {button('pinned', () => setFilter('pinned'))}
        {button('unread', () => setFilter('unread'))}
        {button('bump-obs', () => bump('obsidian'))}
        {button('bump-sq', () => bump('trusty-squire'))}
        {button('bump-bee', () => bump('beeline'))}
        {button('tog-bee', () => cornerDropdowns.toggle('beeline'))}
        {button('tog-sq', () => cornerDropdowns.toggle('trusty-squire'))}
        <Text style={styles.buttonText}>{BEFORE_FIX ? 'before fix' : 'with fix'}</Text>
      </View>
      <SectionList
        testID="room-list"
        sections={sections}
        keyExtractor={(item) => item.room.id}
        extraData={cornerDropdowns.expanded}
        stickySectionHeadersEnabled={false}
        contentContainerStyle={[styles.list, { paddingBottom: 120 }]}
        renderSectionHeader={({ section }) =>
          section.title ? <RoomListSectionHeader title={section.title} /> : null
        }
        renderItem={({ item, index, section }) => {
          const title = item.room.name;
          const first = index === 0;
          const last = index === section.data.length - 1;
          const cornersExpanded = cornerDropdowns.expanded.has(item.room.id);
          const row = (
            <View
              key={BEFORE_FIX ? undefined : `${first}-${last}`}
              style={[
                styles.rowSurface,
                first && styles.rowSurfaceFirst,
                last && styles.rowSurfaceLast,
              ]}
            >
              <ConversationRow
                item={item}
                viewer="viewer"
                now={ageNow}
                onPress={() => swipeableRefs.current.get(item.room.id)?.close()}
                pinned={pinned.includes(item.room.id)}
                onPin={() => undefined}
                cornersExpanded={cornersExpanded}
                onToggleCorners={() => cornerDropdowns.toggle(item.room.id)}
                testID={`room-${item.room.id}`}
              />
              {!item.directMessage && (item.cornerCount ?? 0) > 0 && cornersExpanded && (
                <DesktopRoomCorners
                  item={item}
                  mobile
                  onOpen={() => undefined}
                  renderDrag={(_, children) => children}
                />
              )}
            </View>
          );
          return (
            <View style={[styles.roomCell, last && styles.roomCellLast]}>
              <Swipeable
                ref={(ref) => {
                  if (ref) swipeableRefs.current.set(item.room.id, ref);
                  else swipeableRefs.current.delete(item.room.id);
                }}
                friction={1}
                overshootRight={false}
                rightThreshold={ROW_HEIGHT}
                renderRightActions={() => (
                  <View style={styles.chatActions}>
                    <View style={styles.swipeAction}>
                      <TouchableOpacity
                        accessibilityLabel={`Leave ${title}`}
                        style={styles.swipeActionButton}
                      >
                        <Text style={styles.buttonText}>x</Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                )}
              >
                {row}
              </Swipeable>
            </View>
          );
        }}
      />
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create((theme) => {
  const hull = theme.buzz;
  return {
    container: { flex: 1, backgroundColor: hull.bgTerminal, paddingTop: 40 },
    controls: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, padding: 6 },
    button: {
      paddingHorizontal: 10,
      paddingVertical: 8,
      borderWidth: 1,
      borderColor: hull.borderStrong,
    },
    buttonText: { color: hull.textPrimary, fontSize: 14 },
    list: { paddingTop: hull.roomCard.gap },
    rowSurface: {
      backgroundColor: hull.bgBase,
      borderLeftWidth: 1,
      borderRightWidth: 1,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderColor: hull.border,
      overflow: 'hidden',
    },
    rowSurfaceFirst: {
      borderTopWidth: 1,
      borderTopLeftRadius: hull.roomCard.cornerRadius,
      borderTopRightRadius: hull.roomCard.cornerRadius,
    },
    rowSurfaceLast: {
      borderBottomWidth: 1,
      borderBottomLeftRadius: hull.roomCard.cornerRadius,
      borderBottomRightRadius: hull.roomCard.cornerRadius,
    },
    roomCell: { paddingHorizontal: hull.roomCard.inset },
    roomCellLast: { paddingBottom: hull.roomCard.gap },
    chatActions: { flexDirection: 'row', minHeight: ROW_HEIGHT, backgroundColor: hull.bgHighlight },
    swipeAction: {
      width: ROW_HEIGHT,
      height: ROW_HEIGHT,
      alignItems: 'center',
      justifyContent: 'center',
    },
    swipeActionButton: { width: 26, height: 26, alignItems: 'center', justifyContent: 'center' },
  };
});
