import React, {
  useEffect,
  useLayoutEffect,
  useRef,
  type ComponentProps,
  type ReactNode,
} from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import Animated, {
  Easing,
  FadeOut,
  ReduceMotion,
  interpolateColor,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withTiming,
  type EntryAnimationsValues,
  type EntryExitAnimationFunction,
} from 'react-native-reanimated';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { withAlpha } from '@/buzz/groknight';
import {
  TRANSCRIPT_SETTLE_MS,
  transcriptSettleDecision,
  transcriptSteadyColors,
} from '@/buzz/transcript-motion';
import {
  useTranscriptCardMotion,
  type TranscriptCardMotionSnapshot,
} from './transcript-card-motion-context';

export type TranscriptCardTier = 'record' | 'ask';
export type TranscriptCardRowTone = 'settled' | 'waiting' | 'failed';

export type TranscriptCardRow = {
  id: string;
  state: string;
  title: string;
  kindLine: string;
  tone?: TranscriptCardRowTone;
  onPress?(): void;
};

export type TranscriptCardAction = {
  label: string;
  onPress(): void;
  primary?: boolean;
  disabled?: boolean;
  loading?: boolean;
  testID?: string;
  accessibilityRole?: 'button' | 'link';
};

export type TranscriptCardChoice = {
  id: string;
  letter: string;
  label: string;
  consequence: string;
  costly?: boolean;
  votes?: number;
  share?: number;
  leader?: boolean;
  selected?: boolean;
  onPress?(): void;
};

/** An optional one-line text field above the choice plates (a workflow gate's note). */
type TranscriptCardNoteInput = {
  value: string;
  onChangeText(text: string): void;
  placeholder: string;
  maxLength: number;
  editable?: boolean;
  testID?: string;
};

export type TranscriptCardProps = {
  tier: TranscriptCardTier;
  title: ReactNode;
  wrapTitle?: boolean;
  subline?: ReactNode;
  sublineTestID?: string;
  stamp?: string;
  identity?: ReactNode;
  body?: ReactNode;
  quietBody?: boolean;
  /** Controls an ask needs beyond rows and choices (a field, a step list). */
  children?: ReactNode;
  rows?: readonly TranscriptCardRow[];
  choices?: readonly TranscriptCardChoice[];
  noteInput?: TranscriptCardNoteInput;
  code?: ReactNode;
  codeTestID?: string;
  codePath?: string;
  footerNote?: ReactNode;
  footerNoteTestID?: string;
  footerNoteTone?: 'quiet' | 'failed';
  actions?: readonly TranscriptCardAction[];
  onHeaderPress?(): void;
  headerExpanded?: boolean;
  headerTestID?: string;
  /** A ✕ at the end of the title line that closes the card for good. */
  onDismiss?(): void;
  dismissLabel?: string;
  testID?: string;
};

const settleEasing = Easing.out(Easing.cubic);

function SettlingText({
  active,
  steadyColor,
  durationMs,
  fadeMs = 0,
  delayMs = 0,
  style,
  ...props
}: ComponentProps<typeof Animated.Text> & {
  active: boolean;
  steadyColor: string;
  durationMs: number;
  fadeMs?: number;
  delayMs?: number;
}) {
  const brass = useUnistyles().theme.buzz.accent;
  const progress = useSharedValue(active ? 0 : 1);
  const opacity = useSharedValue(active && fadeMs ? 0 : 1);
  useEffect(() => {
    if (!active) return;
    progress.value = withDelay(
      delayMs,
      withTiming(1, {
        duration: durationMs,
        easing: settleEasing,
        reduceMotion: ReduceMotion.System,
      }),
    );
    if (fadeMs) {
      opacity.value = withDelay(
        delayMs,
        withTiming(1, {
          duration: fadeMs,
          easing: settleEasing,
          reduceMotion: ReduceMotion.System,
        }),
      );
    }
  }, [active, delayMs, durationMs, fadeMs, opacity, progress]);
  const animatedStyle = useAnimatedStyle(() => ({
    color: interpolateColor(progress.value, [0, 1], [brass, steadyColor]),
    opacity: opacity.value,
  }));
  return <Animated.Text {...props} style={[style, animatedStyle]} />;
}

const rowGrowEntering: EntryExitAnimationFunction = (values: EntryAnimationsValues) => {
  'worklet';
  return {
    initialValues: { height: 0 },
    animations: {
      height: withTiming(values.targetHeight, {
        duration: 260,
        easing: settleEasing,
        reduceMotion: ReduceMotion.System,
      }),
    },
  };
};

function rowWashEntering(durationMs: number, brass: string): EntryExitAnimationFunction {
  const brassWash = withAlpha(brass, 0.14);
  const transparentBrass = withAlpha(brass, 0);
  return () => {
    'worklet';
    return {
      initialValues: { backgroundColor: brassWash },
      animations: {
        backgroundColor: withTiming(transparentBrass, {
          duration: durationMs,
          easing: settleEasing,
          reduceMotion: ReduceMotion.System,
        }),
      },
    };
  };
}

function rowRuleEntering(durationMs: number): EntryExitAnimationFunction {
  return () => {
    'worklet';
    return {
      initialValues: { opacity: 1 },
      animations: {
        opacity: withTiming(0, {
          duration: durationMs,
          easing: settleEasing,
          reduceMotion: ReduceMotion.System,
        }),
      },
    };
  };
}

type CardLiveMotion = {
  title: boolean;
  appendedRowIds: ReadonlySet<string>;
  changedRowIds: ReadonlySet<string>;
  durationMs: number;
};

const EMPTY_CARD_LIVE_MOTION: CardLiveMotion = {
  title: false,
  appendedRowIds: new Set(),
  changedRowIds: new Set(),
  durationMs: TRANSCRIPT_SETTLE_MS,
};

/** The single frame and anatomy for every structured card in a transcript. */
export function TranscriptCard({
  tier,
  title,
  wrapTitle = false,
  subline,
  sublineTestID,
  stamp,
  identity,
  children,
  body,
  quietBody = false,
  rows = [],
  choices = [],
  noteInput,
  code,
  codeTestID,
  codePath,
  footerNote,
  footerNoteTestID,
  footerNoteTone = 'quiet',
  actions = [],
  onHeaderPress,
  headerExpanded,
  headerTestID,
  onDismiss,
  dismissLabel = 'Dismiss',
  testID,
}: TranscriptCardProps) {
  const { theme } = useUnistyles();
  const reducedMotion = useReducedMotion();
  const cardMotion = useTranscriptCardMotion();
  const arrivalRequested = cardMotion.arriving;
  const animateArrivalRef = useRef<boolean | null>(null);
  if (animateArrivalRef.current === null) {
    animateArrivalRef.current = arrivalRequested && !reducedMotion;
  }
  const animateArrival = animateArrivalRef.current;
  const arrivalProgress = useSharedValue(animateArrival ? 0 : 1);
  const arrivalOpacity = useSharedValue(animateArrival ? 0 : 1);
  useEffect(() => {
    if (!animateArrival) return;
    arrivalProgress.value = withTiming(1, {
      duration: TRANSCRIPT_SETTLE_MS,
      easing: settleEasing,
      reduceMotion: ReduceMotion.System,
    });
    arrivalOpacity.value = withTiming(1, {
      duration: 240,
      easing: settleEasing,
      reduceMotion: ReduceMotion.System,
    });
  }, [animateArrival, arrivalOpacity, arrivalProgress]);
  const arrivalContentStyle = useAnimatedStyle(() => ({ opacity: arrivalOpacity.value }));
  const arrivalHaloStyle = useAnimatedStyle(() => ({
    opacity: 1 - arrivalProgress.value,
  }));

  const steady = transcriptSteadyColors({
    textPrimary: theme.buzz.textPrimary,
    textSecondary: theme.buzz.textSecondary,
    quiet: theme.buzz.ledgerQuiet,
    ghost: theme.buzz.ledgerGhost,
    waiting: theme.buzz.accent,
    failed: theme.buzz.diffRemoved,
  });
  const currentSnapshot: TranscriptCardMotionSnapshot = {
    title: typeof title === 'string' ? title : null,
    rows: new Map(rows.map((row) => [row.id, row.state])),
  };
  const previousSnapshot = useRef<TranscriptCardMotionSnapshot | null>(null);
  const lastSettleStartedAt = useRef<number | null>(null);
  const storedSnapshot =
    cardMotion.store && cardMotion.cardId
      ? (cardMotion.store.snapshots.get(cardMotion.cardId) ?? null)
      : previousSnapshot.current;
  const appendedRowIds = new Set<string>();
  const changedRowIds = new Set<string>();
  const titleChanged =
    storedSnapshot !== null &&
    currentSnapshot.title !== null &&
    storedSnapshot.title !== currentSnapshot.title;
  if (storedSnapshot) {
    for (const [id, state] of currentSnapshot.rows) {
      if (!storedSnapshot.rows.has(id)) appendedRowIds.add(id);
      else if (storedSnapshot.rows.get(id) !== state) changedRowIds.add(id);
    }
  }
  const hasMutation = titleChanged || appendedRowIds.size > 0 || changedRowIds.size > 0;
  const now = Date.now();
  const storedSettleStartedAt =
    cardMotion.store && cardMotion.cardId
      ? (cardMotion.store.settleStartedAt.get(cardMotion.cardId) ?? null)
      : lastSettleStartedAt.current;
  const settle = hasMutation
    ? transcriptSettleDecision(storedSettleStartedAt, now, reducedMotion)
    : { animate: false, startsNewSettle: false, durationMs: 0 };
  const nextLiveMotion: CardLiveMotion = settle.animate
    ? {
        title: titleChanged,
        appendedRowIds,
        changedRowIds,
        durationMs: settle.durationMs,
      }
    : EMPTY_CARD_LIVE_MOTION;
  const committedLiveMotion = useRef<CardLiveMotion>(EMPTY_CARD_LIVE_MOTION);
  const liveMotion = hasMutation ? nextLiveMotion : committedLiveMotion.current;
  useLayoutEffect(() => {
    // Compare against committed card content. React can render the same update
    // more than once before committing it; consuming the snapshot in render
    // would turn that live mutation into a settled no-op on the second pass.
    if (hasMutation) committedLiveMotion.current = nextLiveMotion;
    if (cardMotion.store && cardMotion.cardId) {
      cardMotion.store.snapshots.set(cardMotion.cardId, currentSnapshot);
      if (settle.startsNewSettle) cardMotion.store.settleStartedAt.set(cardMotion.cardId, now);
    } else if (settle.startsNewSettle) {
      lastSettleStartedAt.current = now;
    }
    previousSnapshot.current = currentSnapshot;
  });

  const hasFooter = footerNote !== undefined || actions.length > 0;
  // A card that is only its head closes with the same inset it opens with.
  const headOnly = !body && code === undefined && !rows.length && !choices.length && !hasFooter;
  return (
    <View style={styles.frameShell}>
      {animateArrival ? (
        <Animated.View
          collapsable={false}
          pointerEvents="none"
          style={[styles.haloLayer, arrivalHaloStyle]}
          testID="transcript-card-arrival-halo"
        >
          <View style={styles.haloFar} />
          <View style={styles.haloMid} />
          <View style={styles.haloNear} />
          <View style={styles.haloRing} />
        </Animated.View>
      ) : null}
      <Animated.View style={arrivalContentStyle}>
        <View style={[styles.frame, tier === 'ask' && styles.ask]} testID={testID}>
          <Pressable
            accessibilityHint={
              onHeaderPress
                ? headerExpanded
                  ? 'Hides individual rows'
                  : 'Shows individual rows'
                : undefined
            }
            accessibilityRole={onHeaderPress ? 'button' : undefined}
            accessibilityState={onHeaderPress ? { expanded: headerExpanded } : undefined}
            disabled={!onHeaderPress}
            onPress={onHeaderPress}
            style={[styles.head, headOnly && styles.headOnly]}
            testID={headerTestID}
          >
            {identity ? <View style={styles.identity}>{identity}</View> : null}
            <View style={styles.headCopy}>
              <View style={styles.titleLine}>
                <SettlingText
                  key={currentSnapshot.title ?? 'title'}
                  active={animateArrival || liveMotion.title}
                  durationMs={animateArrival ? TRANSCRIPT_SETTLE_MS : liveMotion.durationMs}
                  ellipsizeMode="tail"
                  numberOfLines={wrapTitle ? undefined : 1}
                  steadyColor={steady.title}
                  style={styles.title}
                  testID={testID ? `${testID}-title` : undefined}
                >
                  {title}
                </SettlingText>
                {stamp ? <Text style={styles.stamp}>{stamp}</Text> : null}
                {onDismiss ? (
                  <Pressable
                    accessibilityLabel={dismissLabel}
                    accessibilityRole="button"
                    hitSlop={12}
                    onPress={onDismiss}
                    testID={testID ? `${testID}-dismiss` : undefined}
                  >
                    <Text style={styles.dismiss}>✕</Text>
                  </Pressable>
                ) : null}
              </View>
              {subline ? (
                <SettlingText
                  active={animateArrival}
                  durationMs={TRANSCRIPT_SETTLE_MS}
                  steadyColor={steady.quiet}
                  style={styles.subline}
                  testID={sublineTestID}
                >
                  {subline}
                </SettlingText>
              ) : null}
            </View>
          </Pressable>
          {body ? (
            <SettlingText
              active={animateArrival}
              durationMs={TRANSCRIPT_SETTLE_MS}
              steadyColor={quietBody ? steady.quiet : steady.body}
              style={[styles.body, quietBody && styles.bodyQuiet]}
            >
              {body}
            </SettlingText>
          ) : null}
          {children}
          {code !== undefined ? (
            <View style={[styles.code, tier === 'ask' && styles.askCode]} testID={codeTestID}>
              {codePath ? <Text style={styles.codePath}>{codePath}</Text> : null}
              <Text selectable style={styles.codeText}>
                {code}
              </Text>
            </View>
          ) : null}
          {rows.length ? (
            <View style={styles.rows}>
              {rows.map((row) => (
                <TranscriptCardRowView
                  key={row.id}
                  row={row}
                  animateCardArrival={animateArrival}
                  animateEntry={liveMotion.appendedRowIds.has(row.id)}
                  animateState={liveMotion.changedRowIds.has(row.id)}
                  settleDurationMs={liveMotion.durationMs}
                  steady={steady}
                />
              ))}
            </View>
          ) : null}
          {choices.length ? (
            <View style={styles.choices} testID={testID ? `${testID}-choices` : undefined}>
              {noteInput ? (
                <TextInput
                  accessibilityLabel={noteInput.placeholder}
                  editable={noteInput.editable ?? true}
                  maxLength={noteInput.maxLength}
                  onChangeText={noteInput.onChangeText}
                  placeholder={noteInput.placeholder}
                  placeholderTextColor={theme.buzz.ledgerGhost}
                  style={styles.noteInput}
                  testID={noteInput.testID}
                  value={noteInput.value}
                />
              ) : null}
              {choices.map((choice) => (
                <TranscriptCardChoicePlate
                  key={choice.id}
                  choice={choice}
                  closed={tier === 'record'}
                />
              ))}
            </View>
          ) : null}
          {hasFooter ? (
            <View style={styles.footer}>
              {footerNote !== undefined ? (
                <Text
                  testID={footerNoteTestID}
                  style={[
                    styles.footerNote,
                    footerNoteTone === 'failed' && styles.footerNoteFailed,
                  ]}
                >
                  {footerNote}
                </Text>
              ) : (
                <View style={styles.footerSpacer} />
              )}
              <View style={styles.actions}>
                {actions.map((action) => (
                  <Pressable
                    key={`${action.label}-${action.testID ?? ''}`}
                    accessibilityRole={action.accessibilityRole ?? 'button'}
                    accessibilityLabel={action.label}
                    disabled={action.disabled}
                    hitSlop={12}
                    onPress={action.onPress}
                    testID={action.testID}
                  >
                    <Text style={[styles.action, action.primary && styles.actionPrimary]}>
                      {action.loading ? '…' : action.label}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </View>
          ) : null}
        </View>
      </Animated.View>
    </View>
  );
}

function TranscriptCardChoicePlate({
  choice,
  closed,
}: {
  choice: TranscriptCardChoice;
  closed: boolean;
}) {
  const washWidth = closed ? Math.max(0, Math.min(1, choice.share ?? 0)) : 0;
  const inner = (
    <>
      {washWidth > 0 ? (
        <View
          pointerEvents="none"
          style={[
            styles.choiceWash,
            choice.leader ? styles.choiceWashLeader : null,
            { width: `${Math.round(washWidth * 100)}%` },
          ]}
          testID={`transcript-card-choice-wash-${choice.id}`}
        />
      ) : null}
      <View style={styles.choiceInner}>
        <View
          style={[
            styles.choiceLetter,
            choice.selected ? styles.choiceLetterSelected : null,
            choice.costly ? styles.choiceLetterCostly : null,
          ]}
          testID={`transcript-card-choice-letter-${choice.id}`}
        >
          <Text
            style={[
              styles.choiceLetterText,
              choice.selected ? styles.choiceLetterTextSelected : null,
              choice.costly ? styles.choiceLetterTextCostly : null,
            ]}
          >
            {choice.letter}
          </Text>
        </View>
        <View style={styles.choiceCopy}>
          <Text style={[styles.choiceLabel, choice.leader ? styles.choiceLabelLeader : null]}>
            {choice.label}
          </Text>
          {choice.consequence ? (
            <Text style={styles.choiceConsequence}>{choice.consequence}</Text>
          ) : null}
        </View>
        {closed && choice.votes !== undefined ? (
          <Text
            style={[styles.choiceCount, choice.leader ? styles.choiceCountLeader : null]}
            testID={`transcript-card-choice-count-${choice.id}`}
          >
            {choice.votes}
          </Text>
        ) : null}
      </View>
    </>
  );
  const plateStyle = [
    styles.choicePlate,
    closed ? styles.choicePlateClosed : null,
    choice.selected ? styles.choicePlateSelected : null,
  ];
  if (choice.onPress) {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${choice.letter}. ${choice.label}. ${choice.consequence}`}
        onPress={choice.onPress}
        style={({ pressed }) => [plateStyle, pressed && styles.choicePlatePressed]}
        testID={`transcript-card-choice-${choice.id}`}
      >
        {inner}
      </Pressable>
    );
  }
  return (
    <View style={plateStyle} testID={`transcript-card-choice-${choice.id}`}>
      {inner}
    </View>
  );
}

function TranscriptCardRowView({
  row,
  animateCardArrival,
  animateEntry,
  animateState,
  settleDurationMs,
  steady,
}: {
  row: TranscriptCardRow;
  animateCardArrival: boolean;
  animateEntry: boolean;
  animateState: boolean;
  settleDurationMs: number;
  steady: ReturnType<typeof transcriptSteadyColors>;
}) {
  const brass = useUnistyles().theme.buzz.accent;
  const stateColor = steady.rowState[row.tone ?? 'settled'];
  const animateRowText = animateCardArrival || animateEntry;
  const content = (
    <>
      <View style={styles.rowStateSlot}>
        <SettlingText
          key={row.state}
          active={animateState || animateRowText}
          delayMs={animateEntry ? 100 : 0}
          durationMs={animateCardArrival ? TRANSCRIPT_SETTLE_MS : settleDurationMs}
          exiting={
            animateState ? FadeOut.duration(220).reduceMotion(ReduceMotion.System) : undefined
          }
          fadeMs={animateState ? 220 : animateEntry ? 300 : 0}
          steadyColor={stateColor}
          style={[
            styles.rowState,
            row.tone === 'waiting' && styles.rowStateWaiting,
            row.tone === 'failed' && styles.rowStateFailed,
          ]}
        >
          {row.state}
        </SettlingText>
      </View>
      <View style={styles.rowCopy}>
        <SettlingText
          active={animateRowText}
          delayMs={animateEntry ? 100 : 0}
          durationMs={animateCardArrival ? TRANSCRIPT_SETTLE_MS : settleDurationMs}
          ellipsizeMode="tail"
          fadeMs={animateEntry ? 300 : 0}
          numberOfLines={1}
          steadyColor={steady.rowTitle}
          style={styles.rowTitle}
        >
          {row.title}
        </SettlingText>
        <SettlingText
          active={animateRowText}
          delayMs={animateEntry ? 100 : 0}
          durationMs={animateCardArrival ? TRANSCRIPT_SETTLE_MS : settleDurationMs}
          fadeMs={animateEntry ? 300 : 0}
          numberOfLines={1}
          steadyColor={steady.rowKind}
          style={styles.rowKind}
        >
          {row.kindLine}
        </SettlingText>
      </View>
    </>
  );
  const rowContent = row.onPress ? (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={`${row.state}: ${row.title}. ${row.kindLine}`}
      onPress={row.onPress}
      style={styles.row}
      testID={`transcript-card-row-${row.id}`}
    >
      {content}
    </Pressable>
  ) : (
    <View style={styles.row} testID={`transcript-card-row-${row.id}`}>
      {content}
    </View>
  );
  return (
    <Animated.View entering={animateEntry ? rowGrowEntering : undefined} style={styles.rowSlot}>
      {rowContent}
      {animateEntry ? (
        <>
          <Animated.View
            entering={rowWashEntering(settleDurationMs, brass)}
            pointerEvents="none"
            style={styles.rowWash}
          />
          <Animated.View
            entering={rowRuleEntering(settleDurationMs)}
            pointerEvents="none"
            style={styles.rowRule}
          />
        </>
      ) : null}
    </Animated.View>
  );
}

/** Brass inline text for handles embedded in a card title or subline. */
export function TranscriptCardHandle({
  children,
  meta = false,
}: {
  children: ReactNode;
  meta?: boolean;
}) {
  return <Text style={meta ? styles.handleMeta : styles.handle}>{children}</Text>;
}

/** How far the arrival halo's outer ring reaches past the card. The shell
 *  bleeds out by the same amount (negative margin, equal padding) so the halo
 *  has room to draw without moving the card. */
const HALO_REACH = 24;

const styles = StyleSheet.create((theme) => {
  const card = theme.buzz;
  const metric = card.transcriptCard;
  return {
    frameShell: {
      minWidth: 0,
      marginTop: metric.marginTop - HALO_REACH,
      marginRight: -HALO_REACH,
      marginBottom: metric.marginBottom - HALO_REACH,
      marginLeft: -HALO_REACH,
      padding: HALO_REACH,
      position: 'relative',
      borderRadius: metric.cornerRadius,
      overflow: 'visible',
    },
    haloLayer: {
      position: 'absolute',
      top: HALO_REACH,
      right: HALO_REACH,
      bottom: HALO_REACH,
      left: HALO_REACH,
      overflow: 'visible',
    },
    haloRing: {
      ...StyleSheet.absoluteFillObject,
      borderWidth: 1,
      borderColor: withAlpha(card.accent, 0.95),
      borderRadius: metric.cornerRadius,
    },
    haloNear: {
      position: 'absolute',
      top: -4,
      right: -4,
      bottom: -4,
      left: -4,
      borderWidth: 4,
      borderColor: withAlpha(card.accent, 0.3),
      backgroundColor: withAlpha(card.accent, 0.1),
      borderRadius: metric.cornerRadius + 4,
    },
    haloMid: {
      position: 'absolute',
      top: -16,
      right: -16,
      bottom: -16,
      left: -16,
      borderWidth: 7,
      borderColor: withAlpha(card.accent, 0.16),
      backgroundColor: withAlpha(card.accent, 0.06),
      borderRadius: metric.cornerRadius + 16,
    },
    haloFar: {
      position: 'absolute',
      top: -HALO_REACH,
      right: -HALO_REACH,
      bottom: -HALO_REACH,
      left: -HALO_REACH,
      borderWidth: 8,
      borderColor: withAlpha(card.accent, 0.08),
      backgroundColor: withAlpha(card.accent, 0.03),
      borderRadius: metric.cornerRadius + HALO_REACH,
    },
    frame: {
      minWidth: 0,
      borderWidth: 1,
      borderColor: card.border,
      borderRadius: metric.cornerRadius,
      overflow: 'hidden',
    },
    ask: { backgroundColor: card.bgRaised, borderColor: card.borderStrong },
    head: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: card.space.sm,
      paddingTop: metric.headTop,
      paddingHorizontal: metric.side,
    },
    headOnly: { paddingBottom: metric.headTop },
    identity: { width: metric.identitySize },
    headCopy: { flex: 1, minWidth: 0 },
    titleLine: {
      minWidth: 0,
      flexDirection: 'row',
      alignItems: 'baseline',
      gap: card.space.sm,
    },
    title: { ...card.type.bodyStrong, color: card.textPrimary, flex: 1, minWidth: 0 },
    handle: { ...card.type.body, fontFamily: card.proseMedium, color: card.accent },
    handleMeta: { ...card.type.meta, fontFamily: card.proseMedium, color: card.accent },
    stamp: {
      ...card.type.machine,
      color: card.ledgerQuiet,
      fontVariant: ['tabular-nums'],
    },
    dismiss: { ...card.type.machine, color: card.ledgerQuiet },
    subline: { ...card.type.meta, color: card.ledgerQuiet, marginTop: card.space.xs },
    body: {
      ...card.type.body,
      color: card.textSecondary,
      fontSize: metric.bodySize,
      lineHeight: metric.bodyLineHeight,
      paddingTop: card.space.sm,
      paddingHorizontal: metric.side,
    },
    bodyQuiet: { color: card.ledgerQuiet },
    code: {
      marginTop: metric.codeTop,
      marginHorizontal: metric.side,
      paddingVertical: metric.codeVertical,
      paddingHorizontal: metric.codeHorizontal,
      gap: card.space.xs,
      borderRadius: metric.codeRadius,
      backgroundColor: card.bgHighlight,
    },
    askCode: { backgroundColor: card.bgPressed },
    codePath: { ...card.type.machine, fontSize: metric.codePathSize, color: card.ledgerQuiet },
    codeText: { ...card.type.machine, color: card.textSecondary },
    rows: { marginTop: metric.rowVertical },
    row: {
      minWidth: 0,
      flexDirection: 'row',
      paddingVertical: metric.rowVertical,
      paddingHorizontal: metric.side,
      borderTopWidth: 1,
      borderTopColor: card.border,
    },
    rowSlot: { minWidth: 0, overflow: 'hidden' },
    rowWash: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: 'transparent',
    },
    rowRule: {
      position: 'absolute',
      top: 0,
      bottom: 0,
      left: 0,
      width: 3,
      backgroundColor: card.accent,
    },
    rowStateSlot: { width: metric.rowStateWidth },
    rowState: {
      ...card.type.sectionHead,
      fontFamily: card.monoRegular,
      color: card.ledgerQuiet,
    },
    rowStateWaiting: { color: card.accent },
    rowStateFailed: { color: card.diffRemoved },
    rowCopy: { flex: 1, minWidth: 0 },
    rowTitle: {
      ...card.type.body,
      minWidth: 0,
      fontSize: metric.rowTitleSize,
      color: card.textPrimary,
    },
    rowKind: { ...card.type.machine, fontSize: metric.rowKindSize, color: card.ledgerGhost },
    choices: {
      gap: card.space.sm,
      paddingTop: metric.rowVertical,
      paddingBottom: metric.rowVertical,
      paddingHorizontal: metric.side,
    },
    noteInput: {
      ...card.type.body,
      minHeight: 40,
      borderWidth: 1,
      borderColor: card.border,
      borderRadius: card.radius,
      paddingHorizontal: card.space.md,
      paddingVertical: card.space.sm,
      color: card.textPrimary,
    },
    choicePlate: {
      position: 'relative',
      overflow: 'hidden',
      minHeight: 52,
      borderWidth: 1,
      borderColor: card.borderStrong,
      borderRadius: card.radius,
      backgroundColor: card.bgHighlight,
    },
    choicePlateClosed: {
      backgroundColor: 'transparent',
      borderColor: card.border,
    },
    choicePlateSelected: { borderColor: card.accent },
    choicePlatePressed: { backgroundColor: card.bgPressed },
    choiceWash: {
      position: 'absolute',
      top: 0,
      bottom: 0,
      left: 0,
      backgroundColor: card.brassWash,
    },
    choiceWashLeader: { backgroundColor: card.brassWashStrong },
    choiceInner: {
      position: 'relative',
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: card.space.sm,
      paddingVertical: card.space.sm,
      paddingHorizontal: card.space.md,
    },
    choiceLetter: {
      minWidth: metric.identitySize,
      minHeight: metric.identitySize,
      paddingHorizontal: card.space.xs,
      paddingVertical: card.space.xs,
      borderWidth: 1,
      borderColor: card.borderStrong,
      borderRadius: card.radius,
      alignItems: 'center',
      justifyContent: 'center',
    },
    choiceLetterSelected: {
      borderColor: card.accent,
      backgroundColor: card.brassWash,
    },
    choiceLetterCostly: { borderColor: card.diffRemoved },
    choiceLetterText: { ...card.type.bodyStrong, color: card.textPrimary },
    choiceLetterTextSelected: { color: card.accent },
    choiceLetterTextCostly: { color: card.diffRemoved },
    choiceCopy: { flex: 1, minWidth: 0 },
    choiceLabel: { ...card.type.body, color: card.textPrimary },
    choiceLabelLeader: { ...card.type.bodyStrong, color: card.textPrimary },
    choiceConsequence: { ...card.type.meta, color: card.ledgerQuiet, marginTop: card.space.xs },
    choiceCount: {
      ...card.type.machine,
      color: card.ledgerQuiet,
      fontVariant: ['tabular-nums'],
      paddingTop: 4,
      minWidth: 16,
      textAlign: 'right',
    },
    choiceCountLeader: { color: card.accent, fontFamily: card.proseMedium },
    footer: {
      minHeight: metric.footerMinHeight,
      marginTop: metric.footerTop,
      paddingVertical: metric.footerVertical,
      paddingHorizontal: metric.side,
      borderTopWidth: 1,
      borderTopColor: card.border,
      flexDirection: 'row',
      alignItems: 'center',
      gap: card.space.sm,
    },
    footerSpacer: { flex: 1 },
    footerNote: {
      ...card.type.sectionHead,
      fontFamily: card.monoRegular,
      color: card.ledgerQuiet,
      flex: 1,
    },
    footerNoteFailed: { color: card.diffRemoved },
    actions: { flexDirection: 'row', alignItems: 'center', gap: metric.actionGap },
    action: { ...card.type.body, fontSize: metric.actionSize, color: card.ledgerQuiet },
    actionPrimary: { fontFamily: card.proseMedium, color: card.accent },
  };
});
