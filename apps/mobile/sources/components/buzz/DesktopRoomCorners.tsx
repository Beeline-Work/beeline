import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { ChatListItem } from '@beeline/buzz-client';
import { displayGroupedCornerTitle } from '@/buzz/room-list-row';
import { CornerGlyph, CORNER_META_SIZE } from './CornerGlyph';
import { CornerWaitingPulse } from './CornerWaitingPulse';

/** The viewer's open corners in one Room: ones they commissioned or that
 * await them, waiting first. Everyone else's corners stay off the rail. The
 * phone Room list shows the same dropdown under its row. */
export function DesktopRoomCorners({
  item,
  onOpen,
  renderDrag,
  mobile = false,
  corners: listed,
}: {
  item: ChatListItem;
  onOpen: (cornerId: string) => void;
  renderDrag: (cornerId: string, children: React.ReactNode) => React.ReactNode;
  mobile?: boolean;
  /** Corners to list instead of the viewer's own, such as a search's matches. */
  corners?: NonNullable<ChatListItem['openCorners']>;
}) {
  // The chat list carries each Room's open corners; no per-Room corners read.
  const corners = [...(listed ?? (item.openCorners ?? []).filter((corner) => corner.mine))].sort(
    (a, b) => Number(b.state === 'waiting') - Number(a.state === 'waiting'),
  );
  if (corners.length === 0) return null;
  return (
    <View
      style={[styles.list, mobile && styles.mobileList]}
      testID={`desktop-room-corners-${item.room.id}`}
    >
      {corners.map((corner) => {
        const ready = corner.state === 'waiting';
        return (
          <React.Fragment key={corner.id}>
            {renderDrag(
              corner.id,
              <Pressable
                onPress={() => onOpen(corner.id)}
                accessibilityRole="button"
                accessibilityLabel={`Open corner ${corner.name}, ${corner.state}`}
                style={styles.corner}
                testID={`desktop-corner-${corner.id}`}
              >
                <CornerGlyph size={CORNER_META_SIZE} testID={`desktop-corner-glyph-${corner.id}`} />
                <Text numberOfLines={1} style={styles.name}>
                  {displayGroupedCornerTitle(item.room.name, corner.name, corner.id)}
                </Text>
                <CornerWaitingPulse state={corner.state}>
                  <Text style={[styles.state, ready && styles.waiting]}>{corner.state}</Text>
                </CornerWaitingPulse>
              </Pressable>,
            )}
          </React.Fragment>
        );
      })}
    </View>
  );
}
const styles = StyleSheet.create((theme) => ({
  list: {
    paddingLeft: 46,
    paddingRight: theme.buzz.space.md,
    paddingBottom: theme.buzz.space.sm,
  },
  mobileList: { paddingLeft: 14, paddingRight: 14 },
  corner: {
    // On web the row is a <button>; inside the rail's draggable <div> it would
    // shrink to its content and pull the status in beside the name.
    width: '100%',
    minHeight: 32,
    paddingVertical: theme.buzz.space.xs,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.buzz.space.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.buzz.border,
  },
  name: { ...theme.buzz.type.meta, color: theme.buzz.textSecondary, flex: 1 },
  state: { ...theme.buzz.type.meta, color: theme.buzz.ledgerQuiet },
  waiting: { color: theme.buzz.accent },
}));
