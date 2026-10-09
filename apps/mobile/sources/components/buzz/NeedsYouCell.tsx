import React, { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Swipeable } from 'react-native-gesture-handler';
import { StyleSheet } from 'react-native-unistyles';
import type { NeedsYouItemView } from '@beeline/api-contract/phone';
import { compactRelativeTime } from '@/buzz/relative-time';
import { needsYouExpiryLabel } from '@/buzz/needs-you';
import { CORNER_META_SIZE, CornerGlyph } from './CornerGlyph';
import brand from '@/buzz/brand.json';

/** How far a phone swipe travels before the rail it reveals dismisses the cell. */
const SWIPE_RAIL_WIDTH = 96;

/** An age older than this reads in the warning tone. */
const STALE_SECONDS = 24 * 60 * 60;

function sourceLabel(item: NeedsYouItemView): string {
  const name = item.roomName.replace(/^#/, '');
  return item.roomKind === 'corner'
    ? `corner ${name}`
    : item.roomKind === 'room'
      ? `#${name}`
      : name;
}

/** Where the ask sits: a corner reads `parent / corner`, a DM its peer. */
function sourcePath(item: NeedsYouItemView): string {
  const name = item.roomName.replace(/^#/, '');
  const parent = item.parentRoomName?.replace(/^#/, '');
  return item.roomKind === 'corner' && parent ? `${parent} / ${name}` : name;
}

/**
 * One Needs-you cell, as text only: who asks and what (`Hoots asks to run`)
 * with the age at the right, the exact thing asked for (literals in mono),
 * the request's reason or a choice's options, then where it sits, who it is
 * for and when it expires. The verb names the kind, so there is no type
 * label. Tapping opens the exact message; it clears a question, never an
 * approval, which leaves only once decided. A phone swipes a question right
 * to dismiss; a pointer hovers to reveal DISMISS.
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
  const approval = item.approval;
  const age = compactRelativeTime(item.createdAt, now);
  const stale = now / 1000 - item.createdAt > STALE_SECONDS;
  const expiry = needsYouExpiryLabel(item.expiresAt, now);
  const actor = approval?.actor ?? item.author?.name;
  const ask = approval?.ask ?? 'asks you';
  const subject = approval?.subject ?? item.text;
  const meta = [
    ...(approval?.forName ? [`for ${approval.forName}`] : []),
    sourcePath(item),
    ...(expiry ? [approval?.kind === 'choice' ? expiry.replace('expires', 'closes') : expiry] : []),
  ].join(' · ');
  const cell = (
    <Pressable
      accessibilityHint={
        approval
          ? 'Opens the request in its Room'
          : 'Opens the message and clears it from Needs you'
      }
      accessibilityLabel={[
        actor ? `${actor} ${ask}` : null,
        subject,
        approval?.detail,
        sourceLabel(item),
        age,
      ]
        .filter(Boolean)
        .join(', ')}
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
      <View style={styles.head}>
        <Text style={styles.ask} testID={`needs-you-head-${item.messageId}`}>
          {actor ? <Text style={styles.actor}>{actor}</Text> : null}
          {actor ? ` ${ask}` : null}
        </Text>
        {age ? (
          <Text
            style={[styles.age, stale && styles.ageStale]}
            testID={`needs-you-age-${item.messageId}`}
          >
            {age}
          </Text>
        ) : null}
      </View>
      <Text
        style={[styles.text, approval ? approval.literal && styles.literal : styles.quote]}
        testID={`needs-you-text-${item.messageId}`}
      >
        {subject}
      </Text>
      {approval?.detail ? (
        <Text style={styles.detail} testID={`needs-you-detail-${item.messageId}`}>
          {approval.detail}
        </Text>
      ) : null}
      <View style={[styles.meta, desktop && !approval && styles.metaDesktop]}>
        {item.roomKind === 'corner' ? (
          <CornerGlyph size={CORNER_META_SIZE} />
        ) : item.roomKind === 'room' ? (
          <Text style={styles.sigil}>#</Text>
        ) : null}
        <Text numberOfLines={1} style={styles.metaText}>
          {meta}
        </Text>
      </View>
      {desktop && hovered && !approval ? (
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
      ) : null}
    </Pressable>
  );
  // An approval leaves when it is decided, never by a swipe.
  if (desktop || approval) return cell;
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

/** The pointer's dismiss: its offset from the cell's right edge and its touch box. */
const DISMISS_RIGHT = 4;
const DISMISS_SIZE = 44;

const styles = StyleSheet.create((theme) => ({
  cell: {
    minHeight: 78,
    justifyContent: 'center',
    paddingVertical: theme.buzz.space.md,
    paddingHorizontal: theme.buzz.space.md,
    backgroundColor: theme.buzz.bgBase,
  },
  cellActive: { backgroundColor: theme.buzz.bgHighlight },
  cellSelected: { borderLeftWidth: 1, borderLeftColor: theme.buzz.accent },
  head: { flexDirection: 'row', alignItems: 'baseline', gap: theme.buzz.space.sm },
  ask: { ...theme.buzz.type.body, flex: 1, color: theme.buzz.textPrimary },
  actor: { ...theme.buzz.type.bodyStrong, color: theme.buzz.textPrimary },
  age: { ...theme.buzz.type.meta, color: theme.buzz.ledgerQuiet },
  ageStale: { color: brand.mark },
  text: { ...theme.buzz.type.body, marginTop: theme.buzz.space.xs, color: theme.buzz.textPrimary },
  literal: {
    ...theme.buzz.type.machine,
    marginTop: theme.buzz.space.xs,
    color: theme.buzz.textPrimary,
  },
  // A question is quoted: it is the asker's own words, not a request summary.
  quote: {
    paddingLeft: theme.buzz.space.sm,
    borderLeftWidth: 2,
    borderLeftColor: theme.buzz.borderStrong,
  },
  detail: {
    ...theme.buzz.type.meta,
    marginTop: theme.buzz.space.xs,
    color: theme.buzz.textSecondary,
  },
  meta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.buzz.space.sm,
    marginTop: theme.buzz.space.xs,
  },
  sigil: { ...theme.buzz.type.meta, color: brand.mark },
  metaText: { ...theme.buzz.type.meta, flexShrink: 1, color: theme.buzz.ledgerQuiet },
  // A pointer's dismiss sits on the source line, which keeps room for it, so
  // revealing it never covers the sentence or reflows the cell.
  metaDesktop: { paddingRight: DISMISS_RIGHT + DISMISS_SIZE + theme.buzz.space.md },
  dismiss: {
    position: 'absolute',
    right: DISMISS_RIGHT,
    bottom: 0,
    minWidth: DISMISS_SIZE,
    minHeight: DISMISS_SIZE,
    paddingHorizontal: theme.buzz.space.sm,
    paddingBottom: theme.buzz.space.md,
    justifyContent: 'flex-end',
  },
  dismissText: { ...theme.buzz.type.sectionHead, color: theme.buzz.ledgerQuiet },
  dismissMark: { color: theme.buzz.accent },
  // The label leads from the left edge so it reads while the rail is still opening.
  rail: {
    width: SWIPE_RAIL_WIDTH,
    alignItems: 'flex-start',
    paddingLeft: theme.buzz.space.md,
    justifyContent: 'center',
    backgroundColor: theme.buzz.brassWash,
  },
  railText: { ...theme.buzz.type.sectionHead, color: theme.buzz.accent },
}));
