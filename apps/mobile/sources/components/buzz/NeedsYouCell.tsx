import { LedgerDisclosure } from './LedgerDisclosure';
import { TranscriptFactRow } from './IndexRow';
import { ContentTarget } from '@/components/buzz/IndexRow';
import { Button } from './Button';
import React, { useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
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
import { ButtonRow } from './ButtonRow';
import { TranscriptCardChoicePlate } from './ChoicePlate';

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

/**
 * One Needs-you cell: who asks and what (`Hoots wants to run`)
 * with the age at the right, the exact thing asked for (literals in mono),
 * the request's reason or a choice's options, then where it sits, who it is
 * for and when it expires. The verb names the kind, so there is no type
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
  const [scriptOpen, setScriptOpen] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [busy, setBusy] = useState<number | null>(null);
  const sending = useRef(false);
  const unifiedApproval = item.approval && ['grant', 'write-access', 'connector', 'squire'].includes(item.approval.kind);
  const subject = unifiedApproval ? item.approval!.subject : item.text;
  const approval = item.approval?.detail === subject ? { ...item.approval, detail: undefined } : item.approval;
  const sharedGrant = approval?.kind === 'grant' && approval.facts !== undefined;
  const age = compactRelativeTime(item.createdAt, now);
  const stale = now / 1000 - item.createdAt > STALE_SECONDS;
  const expiry = needsYouExpiryLabel(item.expiresAt, now);
  const actor = approval?.actor ?? item.author?.name;
  const ask = approval?.ask ?? 'asks you';
  const actions = onAction ? (approval?.actions ?? []) : [];
  // Inline choice options already name every option, so the "a · b" line goes.
  const choiceActions = actions.some((action) => action.kind === 'choice');
  const meta = [
    ...(!unifiedApproval && approval?.forName ? [`for ${approval.forName}`] : []),
    sourcePath(item),
    ...(unifiedApproval ? [approval?.forName ? `for @${approval.forName.replace(/^@/, '')}` : 'for you'] : []),
    ...(expiry ? [approval?.kind === 'choice' ? expiry.replace('expires', 'closes') : expiry] : []),
  ].join(' · ');
  const send = async (action: NeedsYouActionView, index: number) => {
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
  const source = (
    <ContentTarget
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
        style={[styles.text, approval ? !sharedGrant && approval.literal && styles.literal : styles.quote]}
        testID={`needs-you-text-${item.messageId}`}
      >
        {sharedGrant ? approval.purpose ?? approval.detail ?? subject : subject}
      </Text>
      {sharedGrant ? approval.facts?.map((fact) => (
        <TranscriptFactRow key={fact.label} label={fact.label} value={fact.value} />
      )) : null}
      {approval?.script ? (
        <View>
          <LedgerDisclosure expanded={scriptOpen}
            rowTestID={`needs-you-script-${item.messageId}-toggle`}
            accessibilityLabel="Script" accessibilityState={{ expanded: scriptOpen }}
            onPress={(event) => { event.stopPropagation(); setScriptOpen((open) => !open); }}>
            {`Script · ${approval.script.contents.replace(/\r?\n$/, '').split('\n').length} lines`}
          </LedgerDisclosure>
          {scriptOpen ? <View style={styles.script}>
            <Text style={styles.detail}>{approval.script.path}</Text>
            <Text style={styles.literal} testID={`needs-you-script-${item.messageId}`}>{approval.script.contents}</Text>
          </View> : null}
        </View>
      ) : null}
      {approval?.detail && !choiceActions && !sharedGrant ? (
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
        <Button
          label="Dismiss"
          accessibilityLabel="Dismiss"
          variant="quiet"
          onPress={(event) => {
            event.stopPropagation();
            onDismiss(item);
          }}
          style={styles.dismiss}
          testID={`needs-you-dismiss-${item.messageId}`}
        />
      ) : null}
    </ContentTarget>
  );
  const cell = (
    <View>
      {source}
      {onAction && approval && actions.length ? (
        <View style={styles.actionArea}>
          {actions.map((action, index) => action.kind === 'external' ? (
            <Button key={index} label={action.label} size="inline" variant="secondary"
              accessibilityRole="link" disabled={busy !== null} loading={busy === index}
              onPress={() => void send(action, index)} testID={`needs-you-action-${item.messageId}-${index}`} />
          ) : null)}
          {choiceActions ? (
            <View style={styles.choices}>
              {actions.map((action, index) =>
                action.kind === 'choice' ? (
                  <TranscriptCardChoicePlate
                    key={index}
                    closed={false}
                    choice={{
                      id: `${item.messageId}-${index}`,
                      letter: String.fromCharCode(65 + index),
                      label: action.label,
                      consequence:
                        action.detail && action.detail !== action.label ? action.detail : '',
                      busy: busy === index,
                      disabled: busy !== null,
                      testID: `needs-you-action-${item.messageId}-${index}`,
                      onPress: () => void send(action, index),
                    }}
                  />
                ) : null,
              )}
            </View>
          ) : null}
          {actions.some((action) => action.kind !== 'choice') ? (
            <ButtonRow
              style={styles.actions}
              actions={actions.map((action, index) => ({ action, index })).sort((a, b) => {
                const denied = (action: NeedsYouActionView) => (action.kind === 'grant' || action.kind === 'write-access') && action.decision === 'deny';
                return Number(denied(b.action)) - Number(denied(a.action));
              }).flatMap(({ action, index }) =>
                action.kind === 'choice' || action.kind === 'external'
                  ? []
                  : [
                      {
                        label: action.label,
                        variant: action.kind === 'skip-choice' ? 'quiet' : (action.kind === 'grant' ? action.decision === 'always' : action.kind === 'write-access' && action.decision !== 'deny') ? 'primary' : 'secondary',
                        accessibilityRole: 'button',
                        disabled: busy !== null,
                        loading: busy === index,
                        testID: `needs-you-action-${item.messageId}-${index}`,
                        description: action.detail ? (
                          <Text style={styles.detail}>{action.detail}</Text>
                        ) : undefined,
                        onPress: (event) => {
                          event.stopPropagation();
                          void send(action, index);
                        },
                      },
                    ],
              )}
            />
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
          <Text style={styles.railText}>Dismiss</Text>
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
  // Options are equal alternatives: one full-width plate each, as in a Room.
  choices: { gap: theme.buzz.space.sm, marginTop: theme.buzz.space.sm },
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
