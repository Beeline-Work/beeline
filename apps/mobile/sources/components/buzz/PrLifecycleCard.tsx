import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Pressable, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useReducedMotion } from 'react-native-reanimated';
import type { ChatDisplayMessage } from '@/buzz/room-view-presentation';
import type { NotificationLifecycleState } from '@/buzz/pr-lifecycle';
import { TRANSCRIPT_SETTLE_MS, transcriptSteadyColors } from '@/buzz/transcript-motion';
import { ledgerStamp } from '@/buzz/relative-time';
interface NotificationLifecycleCardProps {
  message: ChatDisplayMessage;
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
 * footer). Other items are contracted (state column, title, kind line with author).
 * Tapping a contracted cell presents it and contracts the previous one.
 */
export const NotificationLifecycleCard = React.memo(function NotificationLifecycleCard({
  message,
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
  const items = useMemo(() => run.items, [run.items]);

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
    const stateCounts = new Map<string, number>();
    for (const item of items) {
      const word = cellDisplayState(item.state);
      stateCounts.set(word, (stateCounts.get(word) ?? 0) + 1);
    }
    const parts = Array.from(stateCounts.entries())
      .sort()
      .map(([state, count]) => `${count} ${state}`);
    return `${items[0]?.kind === 'check' ? 'Check' : 'PR'} · ${parts.join(', ')}`;
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
    <View style={styles.ncFrameShell} testID={`notification-run-${message.id}`}>
      <View style={styles.ncFrame}>
        {/* Header */}
        <View style={styles.ncHead} testID={`notification-run-head-${message.id}`}>
          <View style={styles.ncHeadCopy}>
            <View style={styles.ncTitleLine}>
              <Text style={styles.ncTitle} numberOfLines={1} ellipsizeMode="tail">
                {headline}
              </Text>
              <Text style={styles.ncStamp}>{ledgerStamp(message.timestamp)}</Text>
            </View>
            {run.subline ? (
              <Text style={styles.ncSubline}>
                {run.subline.split(/(@[a-z0-9_-]+)/gi).map((part, index) =>
                  part.startsWith('@') ? (
                    <Text key={index} style={styles.ncAuthorHighlight}>
                      {part}
                    </Text>
                  ) : (
                    part
                  ),
                )}
              </Text>
            ) : null}
          </View>
        </View>

        {/* Presented cell: full controls */}
        <View style={styles.ncCell} testID={`notification-run-cell-${presentedItem.id}`}>
          <View style={styles.ncCellBody}>
            <View style={styles.ncStateSlot}>
              <Animated.Text
                style={[
                  styles.ncState,
                  { color: stateColor(presentedItem.id, steady.rowState[presentedTone]) },
                ]}
              >
                {presentedState}
              </Animated.Text>
            </View>
            <View style={styles.ncCellCopy}>
              <Animated.Text
                style={[
                  styles.ncCellTitle,
                  { color: stateColor(presentedItem.id, theme.buzz.textPrimary) },
                ]}
                numberOfLines={1}
                ellipsizeMode="tail"
              >
                {presentedItem.title}
              </Animated.Text>
              <Text style={styles.ncKindLine}>{presentedItem.kindLine}</Text>
              {presentedItem.actor ? (
                <Text style={styles.ncAuthor}>
                  by{' '}
                  <Text style={styles.ncAuthorHighlight}>
                    @{presentedItem.actor.replace(/^@/, '')}
                  </Text>
                </Text>
              ) : null}
            </View>
          </View>
          <View style={styles.ncCellFooter}>
            <View style={styles.ncFooterSpacer} />
            {presentedItem.cornerId ? (
              <Pressable
                accessibilityRole="link"
                onPress={() => onOpenCorner(presentedItem.cornerId!)}
                testID={`notification-run-cell-corner-${presentedItem.id}`}
              >
                <Text style={styles.ncAction}>Corner →</Text>
              </Pressable>
            ) : null}
            {presentedItem.url ? (
              <Pressable
                accessibilityRole="link"
                onPress={() => onOpenUrl(presentedItem.url!)}
                testID={`notification-run-cell-url-${presentedItem.id}`}
              >
                <Text style={[styles.ncAction, styles.ncActionPrimary]}>View ↗</Text>
              </Pressable>
            ) : null}
          </View>
        </View>

        {/* Contracted cells */}
        {(expanded ? otherItems : []).map((item) => {
          const itemState = cellDisplayState(item.state);
          const itemTone = cellTone(item.state);
          const itemStateColor = steady.rowState[itemTone];
          const kindWithAuthor = item.actor
            ? `${item.kindLine} · @${item.actor.replace(/^@/, '')}`
            : item.kindLine;
          return (
            <Pressable
              key={item.id}
              accessibilityRole="button"
              accessibilityLabel={`${itemState}: ${item.title}`}
              onPress={() => handlePresent(item.id)}
              style={styles.ncCellContracted}
              testID={`notification-run-contracted-${item.id}`}
            >
              <View style={styles.ncCellBody}>
                <View style={styles.ncStateSlot}>
                  <Animated.Text
                    style={[
                      styles.ncStateContracted,
                      { color: stateColor(item.id, itemStateColor) },
                    ]}
                  >
                    {itemState}
                  </Animated.Text>
                </View>
                <View style={styles.ncCellCopy}>
                  <Animated.Text
                    style={[
                      styles.ncCellTitleContracted,
                      { color: stateColor(item.id, theme.buzz.textPrimary) },
                    ]}
                    numberOfLines={1}
                    ellipsizeMode="tail"
                  >
                    {item.title}
                  </Animated.Text>
                  <Text style={styles.ncKindLine}>{kindWithAuthor}</Text>
                </View>
              </View>
            </Pressable>
          );
        })}

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
      </View>
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  ncFrameShell: {
    minWidth: 0,
    marginTop: theme.buzz.transcriptCard.marginTop - theme.buzz.space.md,
    marginRight: -theme.buzz.space.md,
    marginBottom: theme.buzz.transcriptCard.marginBottom - theme.buzz.space.md,
    marginLeft: -theme.buzz.space.md,
    padding: theme.buzz.space.md,
  },
  // The TranscriptCard frame, read from the same tokens (DESIGN.md → Transcript cards).
  ncFrame: {
    minWidth: 0,
    borderWidth: 1,
    borderColor: theme.buzz.borderStrong,
    borderRadius: theme.buzz.transcriptCard.cornerRadius,
    overflow: 'hidden',
  },
  ncHead: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: theme.buzz.space.sm,
    paddingVertical: theme.buzz.space.sm,
    paddingHorizontal: theme.buzz.transcriptCard.side,
  },
  ncHeadCopy: { flex: 1, minWidth: 0 },
  ncTitleLine: {
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: theme.buzz.space.sm,
  },
  ncTitle: {
    ...theme.buzz.type.bodyStrong,
    color: theme.buzz.textPrimary,
    flex: 1,
    minWidth: 0,
  },
  ncStamp: {
    ...theme.buzz.type.machine,
    color: theme.buzz.ledgerQuiet,
    fontVariant: ['tabular-nums'],
  },
  ncSubline: {
    ...theme.buzz.type.meta,
    color: theme.buzz.ledgerQuiet,
    marginTop: theme.buzz.space.xs,
  },
  ncCell: {
    borderTopWidth: 1,
    borderTopColor: theme.buzz.border,
  },
  ncCellBody: {
    minWidth: 0,
    flexDirection: 'row',
    paddingVertical: theme.buzz.transcriptCard.rowVertical,
    paddingHorizontal: theme.buzz.transcriptCard.side,
    gap: theme.buzz.space.sm,
  },
  ncStateSlot: { width: theme.buzz.transcriptCard.rowStateWidth },
  ncState: {
    ...theme.buzz.type.sectionHead,
    fontFamily: theme.buzz.monoRegular,
    color: theme.buzz.ledgerQuiet,
  },
  ncStateContracted: {
    ...theme.buzz.type.sectionHead,
    fontFamily: theme.buzz.monoRegular,
    color: theme.buzz.ledgerQuiet,
  },
  ncCellCopy: { flex: 1, minWidth: 0 },
  ncCellTitle: {
    ...theme.buzz.type.bodyStrong,
    color: theme.buzz.textPrimary,
    minWidth: 0,
    marginBottom: theme.buzz.space.xs,
  },
  ncCellTitleContracted: {
    ...theme.buzz.type.bodyStrong,
    color: theme.buzz.textPrimary,
    minWidth: 0,
  },
  ncKindLine: {
    ...theme.buzz.type.machine,
    fontSize: 13,
    color: theme.buzz.ledgerGhost,
    marginTop: theme.buzz.space.xs,
  },
  ncAuthor: {
    ...theme.buzz.type.machine,
    color: theme.buzz.ledgerQuiet,
    marginTop: 8,
  },
  ncAuthorHighlight: {
    color: theme.buzz.accent,
    fontStyle: 'normal',
  },
  ncCellFooter: {
    minHeight: theme.buzz.transcriptCard.footerMinHeight,
    paddingVertical: theme.buzz.transcriptCard.footerVertical,
    paddingHorizontal: theme.buzz.transcriptCard.side,
    borderTopWidth: 1,
    borderTopColor: theme.buzz.border,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.buzz.space.lg,
    justifyContent: 'flex-end',
  },
  ncFooterSpacer: { flex: 1 },
  ncAction: {
    ...theme.buzz.type.body,
    fontSize: theme.buzz.transcriptCard.actionSize,
    color: theme.buzz.ledgerQuiet,
  },
  ncActionPrimary: {
    fontFamily: theme.buzz.proseMedium,
    color: theme.buzz.accent,
  },
  ncCellContracted: {
    borderTopWidth: 1,
    borderTopColor: theme.buzz.border,
  },
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
