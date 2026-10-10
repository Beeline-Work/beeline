import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { ChatListItem } from '@beeline/buzz-client';
import { displayGroupedCornerTitle } from '@/buzz/room-list-row';
import { CornerGlyph, CORNER_META_SIZE } from './CornerGlyph';
import { CornerWaitingPulse } from './CornerWaitingPulse';
import { useRoomOpenCorners } from '@/buzz/room-corner-store';

/** The viewer's open corners in one Room: ones they follow (started, posted,
 * steered or were tagged in) or that owe them something, waiting first. Everyone else's corners stay off the rail. The
 * phone Room list shows the same dropdown under its row. */
export function DesktopRoomCorners({
  item,
  onOpen,
  mobile = false,
}: {
  item: ChatListItem;
  onOpen: (cornerId: string, name: string) => void;
  mobile?: boolean;
}) {
  // The Room's corner record holds the newest summary of its open corners,
  // seeded by the chat list read; no per-Room corners read.
  const corners = (useRoomOpenCorners(item.room.id, item.openCorners) ?? [])
    .filter((corner) => corner.mine)
    .sort((a, b) => Number(b.state === 'waiting') - Number(a.state === 'waiting'));
  if (corners.length === 0) return null;
  return (
    <View
      style={[styles.list, mobile && styles.mobileList]}
      testID={`desktop-room-corners-${item.room.id}`}
    >
      {corners.map((corner) => {
        const ready = corner.state === 'waiting';
        return (
          <Pressable
            key={corner.id}
            onPress={() => onOpen(corner.id, corner.name)}
            accessibilityRole="button"
            accessibilityLabel={`Open corner ${corner.name}, ${corner.state}`}
            style={styles.corner}
            testID={`desktop-corner-${corner.id}`}
          >
            <CornerGlyph size={CORNER_META_SIZE} testID={`desktop-corner-glyph-${corner.id}`} />
            <Text numberOfLines={1} style={styles.name}>
              <Text style={styles.sigil}>#</Text>
              {displayGroupedCornerTitle(item.room.name, corner.name, corner.id)}
            </Text>
            <CornerWaitingPulse state={corner.state}>
              <Text style={[styles.state, ready && styles.waiting]}>{corner.state}</Text>
            </CornerWaitingPulse>
          </Pressable>
        );
      })}
    </View>
  );
}
const styles = StyleSheet.create((theme) => ({
  list: {
    paddingLeft: theme.buzz.space.xxl,
    paddingRight: theme.buzz.space.md,
    paddingBottom: theme.buzz.space.sm,
  },
  mobileList: { paddingLeft: theme.buzz.space.md, paddingRight: theme.buzz.space.md },
  corner: {
    // On web the row is a <button>; without a full width it would shrink to
    // its content and pull the status in beside the name.
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
  // The same brass `#` every other corner name carries.
  sigil: { color: theme.buzz.accent },
  state: { ...theme.buzz.type.meta, color: theme.buzz.ledgerQuiet },
  waiting: { color: theme.buzz.accent },
}));
