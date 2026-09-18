import React, { useMemo, useState } from 'react';
import { FlatList, Pressable, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { router } from 'expo-router';
import type { CornerListItem } from '@beeline/buzz-client';
import { inspectorCornerWindow } from '@/buzz/inspector-corners';
import { cornerHref } from '@/buzz/corner-navigation';
import { cornerDisplayState } from '@/buzz/corner-display-state';
import { displayCornerTitle } from '@/buzz/room-list-row';
import { CHANGES_LABEL } from '@/buzz/vocabulary';
import { IdentityMark } from '@/components/buzz/IdentityMark';
import { StateCircle } from '@/components/buzz/MonoHull';
import { Typography } from '@/constants/Typography';

/**
 * The Room's dedicated corners index. Windowing is `inspectorCornerWindow` —
 * the same cap, archived fallback, and see-more the desktop work-pane corner
 * list already uses — so this is a second door onto that list, not a third set
 * of rules. The header `◇` and this screen are the door and the room; the
 * inspector remains the desktop work pane's corner list.
 */
export function RoomCornersList({
  corners,
  parentRoomName,
  parentRoomId,
  refreshing,
  onRefresh,
}: {
  corners: readonly CornerListItem[];
  parentRoomName: string;
  parentRoomId: string;
  refreshing?: boolean;
  onRefresh?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const window = useMemo(() => inspectorCornerWindow(corners, expanded), [corners, expanded]);

  return (
    <FlatList
      data={[...window.visible]}
      keyExtractor={(item) => item.corner.id}
      refreshing={refreshing}
      onRefresh={onRefresh}
      contentContainerStyle={corners.length ? undefined : styles.emptyContainer}
      testID="room-corners-list"
      renderItem={({ item }) => {
        const label = displayCornerTitle(parentRoomName, item.corner.name, item.corner.id);
        const display = cornerDisplayState(item);
        return (
          <Pressable
            accessibilityRole="button"
            onPress={() =>
              router.push(cornerHref(item.corner.id, parentRoomId, item.corner.name))
            }
            style={styles.row}
            testID={`room-corner-${item.corner.id}`}
          >
            <IdentityMark
              kind={item.agent?.kind === 'agent' ? 'agent' : 'human'}
              seed={item.agent?.pubkey ?? item.corner.id}
              avatarUrl={item.agent?.avatar}
              face={item.agent?.face}
              name={item.agent?.name ?? 'Corner'}
              size={34}
            />
            <View style={styles.rowCopy}>
              <Text numberOfLines={1} style={styles.rowTitle}>
                {label}
              </Text>
              <Text numberOfLines={1} style={styles.agent}>
                {item.agent
                  ? `Opened by ${item.agent.name}`
                  : (item.latestMessage?.text ?? 'No activity yet')}
              </Text>
            </View>
            <StateCircle state={display.visual} tone={display.tone} />
            <Text style={styles.chevron}>›</Text>
          </Pressable>
        );
      }}
      ListFooterComponent={
        window.overflowLabel ? (
          <Pressable
            accessibilityRole="button"
            onPress={() => setExpanded(true)}
            style={styles.more}
            testID="room-corners-more"
          >
            <Text style={styles.moreLabel}>{window.overflowLabel}</Text>
            <Text style={styles.chevron}>›</Text>
          </Pressable>
        ) : null
      }
      ListEmptyComponent={
        <View style={styles.empty} testID="room-corners-empty">
          <Text style={styles.emptyTitle}>No {CHANGES_LABEL} yet</Text>
          <Text style={styles.emptyText}>
            Go back to {parentRoomName} and ask an Agent to start work.
          </Text>
        </View>
      }
    />
  );
}

const styles = StyleSheet.create((theme) => {
  const hull = theme.buzz;
  return {
    row: {
      minHeight: 70,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 11,
      paddingHorizontal: 16,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: hull.border,
    },
    rowCopy: { flex: 1, minWidth: 0 },
    rowTitle: { ...Typography.default('semiBold'), ...hull.type.body, color: hull.textPrimary },
    agent: { ...Typography.default(), ...hull.type.meta, color: hull.textMuted, marginTop: 3 },
    chevron: { ...Typography.default(), ...hull.type.body, color: hull.textMuted },
    more: {
      minHeight: 44,
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 16,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: hull.border,
    },
    moreLabel: { ...Typography.default(), ...hull.type.meta, color: hull.textMuted, flex: 1 },
    emptyContainer: { flexGrow: 1 },
    empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8, padding: 24 },
    emptyTitle: { ...Typography.default('semiBold'), ...hull.type.body, color: hull.textPrimary },
    emptyText: {
      ...Typography.default(),
      ...hull.type.meta,
      color: hull.textMuted,
      textAlign: 'center',
    },
  };
});
