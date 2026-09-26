import React, { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Swipeable } from 'react-native-gesture-handler';
import { StyleSheet } from 'react-native-unistyles';
import type { NeedsYouItemView } from '@beeline/api-contract/phone';
import { compactRelativeTime } from '@/buzz/relative-time';
import { needsYouExpiryLabel } from '@/buzz/needs-you';
import { ChevronGlyph } from './ChevronGlyph';
import { CORNER_META_SIZE, CornerGlyph } from './CornerGlyph';
import brand from '@/buzz/brand.json';

/** How far a phone swipe travels before the rail it reveals dismisses the cell. */
const SWIPE_RAIL_WIDTH = 96;

function sourceLabel(item: NeedsYouItemView): string {
  const name = item.roomName.replace(/^#/, '');
  return item.roomKind === 'corner' ? `corner ${name}` : item.roomKind === 'room' ? `#${name}` : name;
}

/**
 * One Needs-you cell: the asking sentence, then where and how long ago. Every
 * cell has the same weight — no type, no dot, no tag. Tapping opens the exact
 * message (and counts as handled); a phone swipes right to dismiss, a pointer
 * hovers to reveal DISMISS in place of the chevron.
 */
export function NeedsYouCell({
  item,
  now,
  desktop,
  selected = false,
  onOpen,
  onDismiss,
}: {
  item: NeedsYouItemView;
  now: number;
  desktop: boolean;
  selected?: boolean;
  onOpen: (item: NeedsYouItemView) => void;
  onDismiss: (item: NeedsYouItemView) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const age = compactRelativeTime(item.createdAt, now);
  const expiry = needsYouExpiryLabel(item.expiresAt, now);
  const name = item.roomName.replace(/^#/, '');
  const cell = (
    <Pressable
      accessibilityHint="Opens the message and clears it from Needs you"
      accessibilityLabel={`${item.text}, ${sourceLabel(item)}, ${age}`}
      accessibilityRole="button"
      accessibilityState={desktop ? { selected } : undefined}
      onHoverIn={desktop ? () => setHovered(true) : undefined}
      onHoverOut={desktop ? () => setHovered(false) : undefined}
      onPress={() => onOpen(item)}
      style={({ pressed }) => [
        styles.cell,
        (pressed || hovered || selected) && styles.cellActive,
        selected && styles.cellSelected,
      ]}
      testID={`needs-you-${item.messageId}`}
    >
      <Text style={styles.text} testID={`needs-you-text-${item.messageId}`}>
        {item.text}
      </Text>
      <View style={styles.meta}>
        {item.roomKind === 'corner' ? (
          <CornerGlyph size={CORNER_META_SIZE} />
        ) : item.roomKind === 'room' ? (
          <Text style={styles.sigil}>#</Text>
        ) : null}
        <Text numberOfLines={1} style={styles.metaText}>
          {name}
          {age ? ` · ${age}` : ''}
          {expiry ? ` · ${expiry}` : ''}
        </Text>
      </View>
      {desktop && hovered ? (
        <Pressable
          accessibilityLabel="Dismiss"
          accessibilityRole="button"
          onPress={(event) => {
            event.stopPropagation();
            onDismiss(item);
          }}
          style={styles.dismiss}
          testID={`needs-you-dismiss-${item.messageId}`}
        >
          <Text style={styles.dismissText}>
            DISMISS <Text style={styles.dismissMark}>✕</Text>
          </Text>
        </Pressable>
      ) : (
        <View pointerEvents="none" style={styles.chevron}>
          <ChevronGlyph color={styles.chevronColor.color} size={14} />
        </View>
      )}
    </Pressable>
  );
  if (desktop) return cell;
  return (
    <Swipeable
      friction={1}
      leftThreshold={SWIPE_RAIL_WIDTH / 2}
      onSwipeableOpen={(direction) => {
        if (direction === 'left') onDismiss(item);
      }}
      overshootLeft={false}
      renderLeftActions={() => (
        <View style={styles.rail} testID={`needs-you-swipe-rail-${item.messageId}`}>
          <Text style={styles.railText}>DISMISS</Text>
        </View>
      )}
      testID={`needs-you-swipe-${item.messageId}`}
    >
      {cell}
    </Swipeable>
  );
}

const styles = StyleSheet.create((theme) => ({
  cell: {
    minHeight: 78,
    justifyContent: 'center',
    paddingVertical: 13,
    paddingLeft: theme.buzz.space.md,
    paddingRight: 36,
    backgroundColor: theme.buzz.bgBase,
  },
  cellActive: { backgroundColor: theme.buzz.bgHighlight },
  cellSelected: { borderLeftWidth: 1, borderLeftColor: theme.buzz.accent },
  text: { ...theme.buzz.type.body, color: theme.buzz.textSecondary },
  meta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    marginTop: 5,
  },
  sigil: { ...theme.buzz.type.meta, color: brand.mark },
  metaText: { ...theme.buzz.type.meta, flexShrink: 1, color: theme.buzz.ledgerQuiet },
  chevron: {
    position: 'absolute',
    right: 15,
    top: 0,
    bottom: 0,
    justifyContent: 'center',
  },
  chevronColor: { color: theme.buzz.ledgerGhost },
  dismiss: {
    position: 'absolute',
    right: 4,
    top: 0,
    bottom: 0,
    minWidth: 44,
    paddingHorizontal: 10,
    justifyContent: 'center',
  },
  dismissText: { ...theme.buzz.type.sectionHead, color: theme.buzz.ledgerQuiet },
  dismissMark: { color: theme.buzz.accent },
  rail: {
    width: SWIPE_RAIL_WIDTH,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.buzz.brassWash,
  },
  railText: { ...theme.buzz.type.sectionHead, color: theme.buzz.accent },
}));
