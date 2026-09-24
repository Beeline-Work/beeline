import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { ChatListItem } from '@beeline/buzz-client';
import { displayGroupedCornerTitle } from '@/buzz/room-list-row';
import { CornerGlyph, CORNER_META_SIZE } from './CornerGlyph';

/** The viewer's open corners in one Room: ones they commissioned or that
 * await them, waiting first. Everyone else's corners stay off the rail. */
export function DesktopRoomCorners({
  item,
  onOpen,
  renderDrag,
}: {
  item: ChatListItem;
  onOpen: (cornerId: string) => void;
  renderDrag: (cornerId: string, children: React.ReactNode) => React.ReactNode;
}) {
  // The chat list carries each Room's open corners; no per-Room corners read.
  const corners = (item.openCorners ?? [])
    .filter((corner) => corner.mine)
    .sort((a, b) => Number(b.state === 'waiting') - Number(a.state === 'waiting'));
  if (corners.length === 0) return null;
  return (
    <View style={styles.list} testID={`desktop-room-corners-${item.room.id}`}>
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
                <Text numberOfLines={2} style={styles.name}>
                  {displayGroupedCornerTitle(item.room.name, corner.name, corner.id)}
                </Text>
                <Text style={[styles.state, ready && styles.waiting]}>{corner.state}</Text>
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
    paddingLeft: theme.buzz.space.lg,
    paddingRight: theme.buzz.space.md,
    paddingBottom: theme.buzz.space.md,
  },
  corner: {
    minHeight: 48,
    paddingVertical: theme.buzz.space.sm,
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
