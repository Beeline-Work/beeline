import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Pressable, Text } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useReducedMotion } from 'react-native-reanimated';
import type { ChatDisplayMessage } from '@/buzz/room-view-presentation';
import type { CornerLifecycleView } from '@beeline/api-contract/phone';
import { withCornerChecks, type NotificationLifecycleState } from '@/buzz/pr-lifecycle';
import { TRANSCRIPT_SETTLE_MS, transcriptSteadyColors } from '@/buzz/transcript-motion';
import { LifecycleRow } from './LifecycleRow';
import { LifecycleCard, lifecycleHeadline } from './LifecycleCard';
import { ledgerStamp } from '@/buzz/relative-time';
interface NotificationLifecycleCardProps {
  message: ChatDisplayMessage;
  testID?: string;
  /** In a corner: the corner row the header reads, the source of current check state. */
  cornerLifecycle?: CornerLifecycleView;
  onOpenCorner(cornerId: string): void;
  onOpenUrl(url: string): void;
}
function cellDisplayState(state: NotificationLifecycleState): string {
  return state === 'PR opened' ? 'opened' : state.replace(/^Checks /, '').toLowerCase();
}
function cellTone(state: NotificationLifecycleState): 'waiting' | 'settled' | 'failed' {
  return state === 'Checks failed'
    ? 'failed'
    : state === 'PR opened' || state === 'Opened' || state === 'Checks running'
      ? 'waiting'
      : 'settled';
}
/** One raised card for one uninterrupted run of repository notifications.
 *
 * Accordion model (one cell per PR, issue, corner or check): the most recently updated item is presented
 * with full controls (state column, title, kind line, author, per-cell
 * footer). Other items are selectable (the same row anatomy and actions).
 * Tapping a contracted cell presents it and contracts the previous one.
 */
export const NotificationLifecycleCard = React.memo(function NotificationLifecycleCard({
  message,
  testID,
  cornerLifecycle,
  onOpenCorner,
  onOpenUrl,
}: NotificationLifecycleCardProps) {
  const run = message.notificationLifecycleRun!;
  const reducedMotion = useReducedMotion();
  const { theme } = useUnistyles();
  const steady = useMemo(
    () =>
      transcriptSteadyColors({
        textPrimary: theme.buzz.textPrimary,
        textSecondary: theme.buzz.textSecondary,
        quiet: theme.buzz.ledgerQuiet,
        ghost: theme.buzz.ledgerGhost,
        waiting: theme.buzz.accent,
        failed: theme.buzz.diffRemoved,
      }),
    [theme],
  );

  // Items are already deduplicated by foldPrLifecycleRuns — one cell per identity.
  const items = useMemo(
    () => withCornerChecks(run.items, cornerLifecycle),
    [run.items, cornerLifecycle],
  );

  // Presented cell state: the most recently updated item is the face (index 0).
  const [presentedId, setPresentedId] = useState<string | undefined>();
  const presentedItem = useMemo(
    () => items.find((item) => item.id === presentedId) ?? items[0]!,
    [items, presentedId],
  );
  const otherItems = useMemo(
    () => items.filter((item) => item.id !== presentedItem.id),
    [items, presentedItem.id],
  );
  const [expanded, setExpanded] = useState(false);
  const hiddenCount = otherItems.length;
  const hasExpandStrip = items.length > 1;

  // Header: kind + latest-state summary, each identity counted once.
  const headline = useMemo(() => {
    return lifecycleHeadline(items);
  }, [items]);

  // One settle lane covers incoming events and row selection; history does not flash.
  const stateVersionRef = useRef<Map<string, string> | null>(null);
  const [animatedCells, setAnimatedCells] = useState<Set<string>>(new Set());
  const [settle] = useState(() => new Animated.Value(1));
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const animate = useCallback(
    (ids: Set<string>) => {
      if (settleTimer.current) clearTimeout(settleTimer.current);
      settle.stopAnimation();
      if (reducedMotion) {
        settle.setValue(1);
        setAnimatedCells(new Set());
        return;
      }
      setAnimatedCells(ids);
      settle.setValue(0);
      Animated.timing(settle, {
        toValue: 1,
        duration: TRANSCRIPT_SETTLE_MS,
        useNativeDriver: false,
      }).start();
      settleTimer.current = setTimeout(() => setAnimatedCells(new Set()), TRANSCRIPT_SETTLE_MS);
    },
    [reducedMotion, settle],
  );
  useEffect(() => {
    const previous = stateVersionRef.current;
    stateVersionRef.current = new Map(items.map((item) => [item.id, item.updatedBy]));
    if (!previous) return;
    const changed = new Set(
      items.filter((item) => previous.get(item.id) !== item.updatedBy).map((item) => item.id),
    );
    if (changed.size) animate(changed);
  }, [items, animate]);
  useEffect(() => {
    if (reducedMotion) {
      if (settleTimer.current) clearTimeout(settleTimer.current);
      settle.stopAnimation();
      settle.setValue(1);
      setAnimatedCells(new Set());
    }
    return () => {
      if (settleTimer.current) clearTimeout(settleTimer.current);
      settle.stopAnimation();
    };
  }, [reducedMotion, settle]);
  const handlePresent = useCallback(
    (itemId: string) => {
      setPresentedId(itemId);
      animate(new Set([itemId]));
    },
    [animate],
  );
  const presentedState = cellDisplayState(presentedItem.state);
  const presentedTone = cellTone(presentedItem.state);
  const stateColor = (id: string, steadyColor: string) =>
    animatedCells.has(id)
      ? settle.interpolate({ inputRange: [0, 1], outputRange: [theme.buzz.accent, steadyColor] })
      : steadyColor;

  return (
    <LifecycleCard
      title={headline}
      stamp={ledgerStamp(message.timestamp)}
      testID={testID ?? `notification-run-${message.id}`}
      headerTestID={`notification-run-head-${message.id}`}
    >
      {/* Presented cell: full controls */}
      <LifecycleRow
        item={presentedItem}
        objective={
          presentedItem.state === 'Opened' && presentedItem.id === message.id
            ? message.daemonFact?.objective
            : undefined
        }
        state={presentedState}
        stateColor={{ color: stateColor(presentedItem.id, steady.rowState[presentedTone]) }}
        titleColor={{ color: stateColor(presentedItem.id, theme.buzz.textPrimary) }}
        testID={`notification-run-cell-${presentedItem.id}`}
        cornerActionTestID={
          testID ? `${testID}-primary-action` : `notification-run-cell-corner-${presentedItem.id}`
        }
        urlActionTestID={
          testID ? `${testID}-secondary-action` : `notification-run-cell-url-${presentedItem.id}`
        }
        onOpenCorner={onOpenCorner}
        onOpenUrl={onOpenUrl}
      />

      {(expanded ? otherItems : []).map((item) => (
        <LifecycleRow
          key={item.id}
          item={item}
          objective={
            item.state === 'Opened' && item.id === message.id
              ? message.daemonFact?.objective
              : undefined
          }
          state={cellDisplayState(item.state)}
          stateColor={{ color: stateColor(item.id, steady.rowState[cellTone(item.state)]) }}
          titleColor={{ color: stateColor(item.id, theme.buzz.textPrimary) }}
          testID={`notification-run-cell-${item.id}`}
          onSelect={() => handlePresent(item.id)}
          selectionTestID={`notification-run-contracted-${item.id}`}
          cornerActionTestID={`notification-run-cell-corner-${item.id}`}
          urlActionTestID={`notification-run-cell-url-${item.id}`}
          onOpenCorner={onOpenCorner}
          onOpenUrl={onOpenUrl}
        />
      ))}

      {/* Expand strip: one row under the cells */}
      {hasExpandStrip ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          onPress={() => setExpanded((value) => !value)}
          style={styles.ncMoreStrip}
          testID={`notification-run-expand-${message.id}`}
        >
          <Text style={styles.ncMoreText}>{expanded ? 'less ▴' : `${hiddenCount} more ▾`}</Text>
        </Pressable>
      ) : null}
    </LifecycleCard>
  );
});

const styles = StyleSheet.create((theme) => ({
  ncMoreStrip: {
    flexDirection: 'row',
    justifyContent: 'center',
    paddingVertical: theme.buzz.space.sm,
    paddingHorizontal: theme.buzz.transcriptCard.side,
    borderTopWidth: 1,
    borderTopColor: theme.buzz.border,
  },
  ncMoreText: {
    ...theme.buzz.type.machine,
    color: theme.buzz.ledgerQuiet,
  },
}));
