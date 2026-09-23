import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { ChevronGlyph } from '@/components/buzz/ChevronGlyph';
import { compactNewMessageCount } from '@/buzz/room-new-message-boundary';
import { TURN_LINE_BAR_MARGIN_BOTTOM, TURN_LINE_ROW_MIN_HEIGHT } from '@/buzz/room-bottom-chrome';

/**
 * The jump control is a 44pt disc — the one round box in the transcript,
 * because it is the one control that floats over the ledger rather than
 * sitting in chrome, and a circle is what reads as liftable there. The plate
 * IS the hit box: 44 is the minimum touch target, so nothing is gained by
 * drawing smaller inside it.
 */
const DISC_SIZE = 44;
const CHEVRON_SIZE = 20;
const BADGE_SIZE = 18;

/**
 * Everything a reader who is behind gets, drawn over the transcript by
 * `_chat-surface.tsx` from one hook (`buzz/use-new-message-control.ts`):
 *
 * - the disc, a way back to the newest message. It shows whenever that row is
 *   off screen, with or without unread mail behind it, and it always lands on
 *   the tail. The `N new` pill it replaces appeared only for unread mail and
 *   landed on the first unread row, so a reader who had scrolled up to re-read
 *   something had no way back down but their own thumb;
 * - the badge on that disc, a counter capped at `9+`, cleared by reaching the
 *   newest row rather than by a press. The disc outlives the badge;
 * Catch-up is NOT here. It lives on the unread line itself
 * (`buzz/room-message-cell.tsx`), where the run it would summarize begins,
 * and the `/catch-up` verb opens the same sheet from the composer. Two doors,
 * one of them visible and labelled.
 *
 * This control held that door twice, and both were wrong. A strip under the
 * Room header floated over the transcript in every Room the reader was behind
 * in, which is the one place a reader is trying to read. A long-press on the
 * disc replaced it with an affordance nothing announces.
 *
 * The badge is the disc's own business. Drawing it only when catch-up was on
 * offer hid this visit's arrival count in every Room under the six-turn/
 * fifteen-message threshold.
 */
export function RoomCatchUpControls({
  corner,
  badgeCount,
  discVisible,
  onJumpToNewest,
}: {
  corner: boolean;
  badgeCount: number;
  discVisible: boolean;
  onJumpToNewest: () => void;
}) {
  const badgeShown = !corner && badgeCount > 0;
  return (
    <>
      {discVisible && (
        <Pressable
          accessibilityLabel={
            badgeShown
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
          {badgeShown && (
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
      // changed with the line would move the disc under the reader. Derived,
      // never a literal: the lift moved from 37 to 40 the week the composer
      // top gap became a literal 12 (a338a989), and nothing here had to change.
      bottom: 4 + TURN_LINE_ROW_MIN_HEIGHT + TURN_LINE_BAR_MARGIN_BOTTOM,
      width: DISC_SIZE,
      height: DISC_SIZE,
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
  };
});
