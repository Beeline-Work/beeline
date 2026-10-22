import React, { useRef, useState } from 'react';
import { Pressable, Text, View, type PressableProps } from 'react-native';
import { Swipeable } from 'react-native-gesture-handler';
import { StyleSheet } from 'react-native-unistyles';
import {
  cornerTitle,
  directMessageTitle,
  roomTitle,
  type NeedsYouItemView,
  type NeedsYouActionView,
} from '@beeline/api-contract/phone';
import { compactRelativeTime } from '@/buzz/relative-time';
import { needsYouExpiryLabel } from '@/buzz/needs-you';
import { CORNER_META_SIZE, CornerGlyph } from './CornerGlyph';
import brand from '@/buzz/brand.json';
import { HullDialogActions } from './HullDialog';
import { PixelLoader } from './MonoHull';

/** How far a phone swipe travels before the rail it reveals dismisses the cell. */
const SWIPE_RAIL_WIDTH = 96;

/** An age older than this reads in the warning tone. */
const STALE_SECONDS = 24 * 60 * 60;

/** Where the ask sits, titled like every other surface names it. */
function sourceTitle(item: NeedsYouItemView): string {
  if (item.roomKind === 'corner')
    return cornerTitle(item.parentRoomName, item.roomName, item.roomId);
  if (item.roomKind === 'room') return roomTitle(item.roomName) ?? item.roomName;
  return directMessageTitle({ name: item.roomName });
}

function sourceLabel(item: NeedsYouItemView): string {
  return item.roomKind === 'corner' ? `corner ${sourceTitle(item)}` : sourceTitle(item);
}

/** The meta line draws a Room's or corner's mark as a glyph, so its title drops the `#`. */
function sourcePath(item: NeedsYouItemView): string {
  const title = sourceTitle(item);
  return item.roomKind === 'direct' ? title : title.replace(/^#/, '');
}

/** Choice option ids are the letters A–D. Anything else falls back to that order. */
const CHOICE_PLATE_LETTERS = ['A', 'B', 'C', 'D'] as const;

function choicePlateLetter(optionId: string, ordinal: number): string {
  if (optionId.length === 1 && optionId >= 'A' && optionId <= 'D') return optionId;
  return CHOICE_PLATE_LETTERS[ordinal] ?? String(ordinal + 1);
}

/**
 * One Needs-you cell: who asks and what (`Hoots asks to run`)
 * with the age at the right, the exact thing asked for (literals in mono),
 * the request's reason, then where it sits, who it is for and when it expires.
 * A choice's options are full-width plates under the cell, so their labels are
 * not repeated on the reason line. The verb names the kind, so there is no type
 * label. Tapping opens the exact message; it clears a question, never an
 * approval. Inline actions use the existing card decision operations; Squire opens
 * its own ceremony. A phone swipes any cell right to dismiss it from the tray;
 * a pointer hovers to reveal DISMISS. Dismissal does not decide an approval.
 */
export function NeedsYouCell({
  item,
  now,
  desktop,
  selected = false,
  onOpen,
  onDismiss,
  onAction,
}: {
  item: NeedsYouItemView;
  now: number;
  desktop: boolean;
  selected?: boolean;
  onOpen: (item: NeedsYouItemView) => void;
  onDismiss: (item: NeedsYouItemView) => void;
  onAction?: (item: NeedsYouItemView, action: NeedsYouActionView) => Promise<void>;
}) {
  const [hovered, setHovered] = useState(false);
  const [busy, setBusy] = useState<number | null>(null);
  const sending = useRef(false);
  const approval = item.approval;
  const age = compactRelativeTime(item.createdAt, now);
  const stale = now / 1000 - item.createdAt > STALE_SECONDS;
  const expiry = needsYouExpiryLabel(item.expiresAt, now);
  const actor = approval?.actor ?? item.author?.name;
  const ask = approval?.ask ?? 'asks you';
  const subject = item.text;
  const inlineChoices = Boolean(
    onAction && approval?.actions?.some((action) => action.kind === 'choice'),
  );
  const decide = async (action: NeedsYouActionView, index: number) => {
    if (!onAction || sending.current) return;
    sending.current = true;
    setBusy(index);
    try {
      await onAction(item, action);
    } finally {
      sending.current = false;
      setBusy(null);
    }
  };
  const dialogAction = (action: NeedsYouActionView, index: number) => ({
    label: action.label,
    variant:
      action.kind === 'skip-choice' ||
      action.kind === 'external' ||
      ((action.kind === 'grant' || action.kind === 'write-access') && action.decision === 'deny')
        ? ('quiet' as const)
        : ('primary' as const),
    accessibilityRole: action.kind === 'external' ? ('link' as const) : ('button' as const),
    disabled: busy !== null,
    loading: busy === index,
    testID: `needs-you-action-${item.messageId}-${index}`,
    description: action.detail ? <Text style={styles.detail}>{action.detail}</Text> : undefined,
    onPress: (event: { stopPropagation(): void }) => {
      event.stopPropagation();
      void decide(action, index);
    },
  });
  const dialogActions = (approval?.actions ?? []).flatMap((action, index) =>
    inlineChoices && action.kind === 'choice' ? [] : [dialogAction(action, index)],
  );
  const meta = [
    ...(approval?.forName ? [`for ${approval.forName}`] : []),
    sourcePath(item),
    ...(expiry ? [approval?.kind === 'choice' ? expiry.replace('expires', 'closes') : expiry] : []),
  ].join(' · ');
  const source = (
    <Pressable
      accessibilityHint={
        approval
          ? 'Opens the request in its Room'
          : 'Opens the message and clears it from Needs you'
      }
      accessibilityLabel={[
        actor ? `${actor} ${ask}` : null,
        subject,
        inlineChoices ? null : approval?.detail,
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
      {approval?.detail && !inlineChoices ? (
        <Text style={styles.detail} testID={`needs-you-detail-${item.messageId}`}>
          {approval.detail}
        </Text>
      ) : null}
      <View style={[styles.meta, desktop && styles.metaDesktop]}>
        {item.roomKind === 'corner' ? (
          <CornerGlyph size={CORNER_META_SIZE} />
        ) : item.roomKind === 'room' ? (
          <Text style={styles.sigil}>#</Text>
        ) : null}
        <Text numberOfLines={1} style={styles.metaText}>
          {meta}
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
      ) : null}
    </Pressable>
  );
  const cell = (
    <View>
      {source}
      {onAction && approval?.actions?.length ? (
        <View style={styles.actionArea}>
          {approval?.script ? (
            <View style={styles.script}>
              <Text style={styles.detail}>{approval.script.path}</Text>
              <Text style={styles.literal} testID={`needs-you-script-${item.messageId}`}>
                {approval.script.contents}
              </Text>
            </View>
          ) : null}
          {inlineChoices ? (
            <View style={styles.choiceStack}>
              {(approval?.actions ?? []).map((action, index) => {
                if (action.kind !== 'choice') return null;
                const ordinal = (approval?.actions ?? [])
                  .slice(0, index)
                  .filter((entry) => entry.kind === 'choice').length;
                const letter = choicePlateLetter(action.optionId, ordinal);
                const consequence =
                  action.detail && action.detail !== action.label ? action.detail : '';
                const plateBusy = busy === index;
                return (
                  <Pressable
                    key={`${action.choiceId}:${action.optionId}`}
                    accessibilityLabel={
                      consequence ? `${letter}. ${action.label}. ${consequence}` : `${letter}. ${action.label}`
                    }
                    accessibilityRole="button"
                    accessibilityState={{ busy: plateBusy, disabled: plateBusy }}
                    aria-busy={plateBusy}
                    aria-disabled={plateBusy}
                    // React Native Web paints dataSet on the DOM node. Pressable's
                    // types omit it, and the tray proof reads data-variant from there.
                    {...({ dataSet: { variant: 'secondary' } } as PressableProps)}
                    disabled={plateBusy}
                    onPress={(event) => {
                      event.stopPropagation();
                      void decide(action, index);
                    }}
                    style={({ pressed }) => [
                      styles.choicePlate,
                      pressed && !plateBusy && styles.choicePlatePressed,
                      plateBusy && styles.choicePlateBusy,
                    ]}
                    testID={`needs-you-action-${item.messageId}-${index}`}
                  >
                    <View style={styles.choiceLetter}>
                      <Text style={[styles.choiceLetterText, plateBusy && styles.choiceBusyText]}>
                        {letter}
                      </Text>
                    </View>
                    <View style={styles.choiceCopy}>
                      <Text style={[styles.choiceLabel, plateBusy && styles.choiceBusyText]}>
                        {action.label}
                      </Text>
                      {consequence ? (
                        <Text style={[styles.choiceConsequence, plateBusy && styles.choiceBusyText]}>
                          {consequence}
                        </Text>
                      ) : null}
                    </View>
                    {plateBusy ? <PixelLoader compact /> : null}
                  </Pressable>
                );
              })}
            </View>
          ) : null}
          {dialogActions.length ? (
            <HullDialogActions style={styles.actions} actions={dialogActions} />
          ) : null}
        </View>
      ) : null}
    </View>
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
  actionArea: { paddingHorizontal: theme.buzz.space.md, paddingBottom: theme.buzz.space.md },
  actions: { marginTop: theme.buzz.space.sm },
  // Same lettered plate as a Room choice: full width, outlined, label over its consequence.
  choiceStack: { marginTop: theme.buzz.space.sm, gap: theme.buzz.space.sm, alignSelf: 'stretch' },
  choicePlate: {
    alignSelf: 'stretch',
    width: '100%',
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: theme.buzz.space.sm,
    paddingVertical: theme.buzz.space.sm,
    paddingHorizontal: theme.buzz.space.md,
    borderWidth: 1,
    borderColor: theme.buzz.borderStrong,
    borderRadius: theme.buzz.radius,
    backgroundColor: theme.buzz.bgHighlight,
  },
  choicePlatePressed: { backgroundColor: theme.buzz.bgPressed },
  choicePlateBusy: { borderColor: theme.buzz.border },
  choiceLetter: {
    minWidth: theme.buzz.transcriptCard.identitySize,
    minHeight: theme.buzz.transcriptCard.identitySize,
    paddingHorizontal: theme.buzz.space.xs,
    paddingVertical: theme.buzz.space.xs,
    borderWidth: 1,
    borderColor: theme.buzz.borderStrong,
    borderRadius: theme.buzz.radius,
    alignItems: 'center',
    justifyContent: 'center',
  },
  choiceLetterText: { ...theme.buzz.type.bodyStrong, color: theme.buzz.textPrimary },
  choiceCopy: { flex: 1, minWidth: 0 },
  choiceLabel: { ...theme.buzz.type.body, color: theme.buzz.textPrimary },
  choiceConsequence: {
    ...theme.buzz.type.meta,
    marginTop: theme.buzz.space.xs,
    color: theme.buzz.ledgerQuiet,
  },
  choiceBusyText: { color: theme.buzz.textDisabled },
  action: { flexShrink: 1 },
  script: { marginTop: theme.buzz.space.sm },
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
