import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { ChevronGlyph } from '@/components/buzz/ChevronGlyph';
import { compactNewMessageCount } from '@/buzz/room-new-message-boundary';
import {
  TURN_LINE_BAR_MARGIN_BOTTOM,
  TURN_LINE_ROW_MIN_HEIGHT,
} from '@/buzz/room-bottom-chrome';

/**
 * The jump control is a disc — the one round box in the transcript, because it
 * is the one control that floats over the ledger rather than sitting in
 * chrome, and a circle is what reads as liftable there. Its 36pt plate is
 * centred in the standard 44pt hit box.
 */
const DISC_SIZE = 36;
const HIT_SIZE = 44;
const CHEVRON_SIZE = 18;
const BADGE_SIZE = 18;

/**
 * The two things a reader who is behind gets, drawn over the transcript by
 * `_chat-surface.tsx` from one hook (`buzz/use-new-message-control.ts`):
 *
 * - the disc, a way back to the newest message. It shows whenever that row is
 *   off screen, with or without unread mail behind it, and it always lands on
 *   the tail. The `N new` pill it replaces appeared only for unread mail and
 *   landed on the first unread row, so a reader who had scrolled up to re-read
 *   something had no way back down but their own thumb;
 * - the badge on that disc, which counts the unread run. Seeing the newest row
 *   clears it without a tap, and the disc outlives the badge;
 * - the catch-up strip, which says what that run is — how many and from whom —
 *   and keeps the pill's old landing: the first message the reader missed.
 */
export function RoomCatchUpControls({
  badgeCount,
  catchUpSummary,
  catchUpVisible,
  discVisible,
  onJumpToFirstNew,
  onJumpToNewest,
}: {
  badgeCount: number;
  catchUpSummary: string;
  catchUpVisible: boolean;
  discVisible: boolean;
  onJumpToFirstNew: () => void;
  onJumpToNewest: () => void;
}) {
  return (
    <>
      {catchUpVisible && (
        <Pressable
          accessibilityLabel={`${catchUpSummary}. Jump to the first one`}
          accessibilityRole="button"
          onPress={onJumpToFirstNew}
          style={({ pressed }) => [styles.strip, pressed && styles.pressed]}
          testID="catch-up-summary-strip"
        >
          <Text numberOfLines={1} style={styles.stripText}>
            {catchUpSummary}
          </Text>
        </Pressable>
      )}
      {discVisible && (
        <Pressable
          accessibilityLabel={
            badgeCount > 0
              ? `${badgeCount} new ${badgeCount === 1 ? 'message' : 'messages'}. Jump to newest message`
              : 'Jump to newest message'
          }
          accessibilityRole="button"
          onPress={onJumpToNewest}
          style={({ pressed }) => [styles.hitTarget, pressed && styles.pressed]}
          testID="newest-jump-disc"
        >
          <View style={styles.disc}>
            <ChevronGlyph color={styles.chevron.color} direction="down" size={CHEVRON_SIZE} />
          </View>
          {badgeCount > 0 && (
            <View style={styles.badge} testID="newest-jump-badge">
              <Text style={styles.badgeText}>{compactNewMessageCount(badgeCount)}</Text>
            </View>
          )}
        </Pressable>
      )}
    </>
  );
}

const styles = StyleSheet.create((theme) => {
  const groknight = theme.buzz;
  return {
    hitTarget: {
      position: 'absolute',
      right: 12,
      // Clear of the turn line. Both are pinned to the right edge above the
      // composer, and the line paints the transcript's bottom margin
      // (`room-bottom-chrome`), so a control sitting on the bottom has the
      // line's STOP control drawn across it. Lifting by the line's own box
      // keeps them apart whether or not an agent is working — an offset that
      // changed with the line would move the disc under the reader.
      bottom: 4 + TURN_LINE_ROW_MIN_HEIGHT + TURN_LINE_BAR_MARGIN_BOTTOM,
      width: HIT_SIZE,
      height: HIT_SIZE,
      alignItems: 'center',
      justifyContent: 'center',
    },
    pressed: {
      opacity: 0.72,
    },
    disc: {
      width: DISC_SIZE,
      height: DISC_SIZE,
      borderRadius: DISC_SIZE / 2,
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: groknight.borderStrong,
      backgroundColor: groknight.bgHighlight,
    },
    /** The chevron drawn on that plate; a glyph takes its colour as a prop. */
    chevron: {
      color: groknight.ledgerBody,
    },
    // The count rides the disc's top-right corner, so the chevron keeps the
    // whole plate and the number never widens the control.
    badge: {
      position: 'absolute',
      top: 0,
      right: 0,
      minWidth: BADGE_SIZE,
      height: BADGE_SIZE,
      paddingHorizontal: groknight.space.xs,
      borderRadius: BADGE_SIZE / 2,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: groknight.accent,
    },
    badgeText: {
      ...Typography.default('semiBold'),
      ...groknight.type.meta,
      color: groknight.textInverted,
      fontVariant: ['tabular-nums'],
    },
    // The strip rides the top of the transcript, where the run the reader is
    // behind on begins, rather than beside the disc that leaves it.
    strip: {
      position: 'absolute',
      top: groknight.space.sm,
      left: 12,
      right: 12,
      paddingHorizontal: groknight.space.sm,
      paddingVertical: groknight.space.xs,
      alignItems: 'center',
      borderRadius: groknight.radius,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: groknight.borderStrong,
      backgroundColor: groknight.bgHighlight,
    },
    stripText: {
      ...Typography.default('semiBold'),
      ...groknight.type.meta,
      color: groknight.ledgerQuiet,
      fontVariant: ['tabular-nums'],
    },
  };
});
