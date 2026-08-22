import React, { useMemo, useState } from 'react';
import { Modal as RNModal, Pressable, ScrollView, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { AgentActivityItem } from '@/sync/transport/rig-transport';
import {
  buildTurnActivity,
  type TurnActivityAction,
  type TurnActivityFile,
} from '@/buzz/activity-timeline';
import { Typography } from '@/constants/Typography';
import { darkTheme } from '@/theme';
import {
  HullActivityTip,
  HullMechanismRail,
  HullMechanismReveal,
  HullSurface,
} from './MonoHull';
import { MonoMarkdown } from './MonoMarkdown';

const diffColors = darkTheme.colors.diff;

type ActivityTimelineProps = {
  active?: boolean;
  items: readonly AgentActivityItem[];
  /**
   * The speaking agent's handle, set inline at the head of the mechanism rows
   * so a Room's tool run still says whose it is without taking a row of its
   * own. A Corner passes nothing: its one agent is named in the top bar.
   */
  handle?: string;
  testID?: string;
};

/**
 * Kind → leading glyph. One glyph per kind, and the glyph is the *only* thing
 * that says which kind a row is — tone says how much it matters, indentation
 * says how mechanical it is, and no channel ever doubles up with another.
 */
const ROW_GLYPH: Record<TurnActivityAction['weight'], string> = {
  mutation: '▧',
  command: '›_',
  failure: '!',
  observation: '◈',
};

function ObjectiveChecklist({ plan }: { plan: NonNullable<AgentActivityItem['plan']> }) {
  const title = plan.objective?.trim() || 'Current objective';
  return (
    <View style={styles.objective} testID="corner-objective-checklist">
      <Text style={styles.objectiveEyebrow}>OBJECTIVE</Text>
      <Text style={styles.objectiveTitle}>{title}</Text>
      {plan.items.map((item, index) => {
        const completed = item.status === 'completed';
        return (
          <View key={`${index}-${item.step}`} style={styles.checklistRow}>
            <Text style={[styles.checklistMark, completed && styles.checklistDone]}>
              {completed ? '✓' : item.status === 'in_progress' ? '◐' : '□'}
            </Text>
            <Text style={[styles.checklistText, completed && styles.checklistDone]}>
              {item.step}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

function DetailText({ label, value }: { label: string; value?: string }) {
  if (!value) return null;
  return (
    <View style={styles.detailBlock}>
      <Text style={styles.detailLabel}>{label}</Text>
      <ScrollView horizontal nestedScrollEnabled showsHorizontalScrollIndicator>
        <Text selectable style={styles.detailCode}>
          {value}
        </Text>
      </ScrollView>
    </View>
  );
}

function ActionDetail({
  action,
  file,
  onBack,
  onSelectFile,
}: {
  action: TurnActivityAction;
  file: TurnActivityFile | null;
  onBack: () => void;
  onSelectFile: (file: TurnActivityFile) => void;
}) {
  if (file) {
    return (
      <View style={styles.detailView} testID="activity-file-detail">
        <Pressable accessibilityRole="button" onPress={onBack} style={styles.backRow}>
          <Text style={styles.backText}>‹ FILES</Text>
        </Pressable>
        <Text selectable style={styles.detailTitle}>{file.path}</Text>
        <ScrollView nestedScrollEnabled style={styles.detailScroll}>
          {file.diff ? (
            <ScrollView horizontal nestedScrollEnabled showsHorizontalScrollIndicator>
              <View style={styles.diffBody}>
                {file.diff.split('\n').map((line, index) => (
                  <Text
                    key={`${index}-${line.slice(0, 24)}`}
                    selectable
                    style={[
                      styles.diffLine,
                      line.startsWith('+') && !line.startsWith('+++')
                        ? styles.diffAdded
                        : line.startsWith('-') && !line.startsWith('---')
                          ? styles.diffRemoved
                          : line.startsWith('@@')
                            ? styles.diffHeader
                            : undefined,
                    ]}
                  >
                    {line || ' '}
                  </Text>
                ))}
              </View>
            </ScrollView>
          ) : (
            <Text style={styles.emptyDetail}>No inline patch was supplied for this file.</Text>
          )}
        </ScrollView>
      </View>
    );
  }

  return (
    <View style={styles.detailView} testID={`activity-detail-${action.kind}`}>
      <Pressable accessibilityRole="button" onPress={onBack} style={styles.backRow}>
        <Text style={styles.backText}>‹ TOOL CALLS</Text>
      </Pressable>
      <Text selectable style={styles.detailTitle}>
        {action.title}
      </Text>
      <ScrollView nestedScrollEnabled style={styles.detailScroll}>
        {action.files?.length ? (
          <View testID="activity-file-list">
            {action.files.map((candidate) => (
              <Pressable
                accessibilityLabel={`Inspect diff for ${candidate.path}`}
                accessibilityRole="button"
                key={candidate.path}
                onPress={() => onSelectFile(candidate)}
                style={styles.fileRow}
                testID={`activity-file-${action.id}:${candidate.path}`}
              >
                <Text style={styles.fileGlyph}>▧</Text>
                <Text numberOfLines={1} style={styles.filePath}>{candidate.path}</Text>
                {candidate.status ? (
                  <Text style={styles.mechanismMeta}>{candidate.status.toUpperCase()}</Text>
                ) : null}
                <Text style={styles.noteAffordance}>›</Text>
              </Pressable>
            ))}
          </View>
        ) : (
          <>
            <DetailText label="COMMAND" value={action.command} />
            <DetailText label="INPUT" value={action.input} />
            <DetailText label="OUTPUT" value={action.output} />
            {!action.command && !action.input && !action.output ? (
              <Text style={styles.emptyDetail}>
                No additional detail was supplied.
              </Text>
            ) : null}
          </>
        )}
      </ScrollView>
    </View>
  );
}

/**
 * One mechanism row: a mutation, a command, or a failure.
 *
 * Everything about it is one channel doing one job. The glyph names the kind,
 * the tone names how much it matters (a path the agent changed lifts to the
 * ledger's body tier; a command's human title stays quiet; a failure lifts
 * all the way, because after the accent is spent on live state persistence and
 * luminance are the only escalation left), and the fixed indent says it is
 * machinery rather than the agent's voice.
 */
function MechanismRow({
  action,
  onPress,
  idPrefix = 'activity-action',
}: {
  action: TurnActivityAction;
  onPress: () => void;
  /** A failure shows both on the slab and in the sheet, so the two need
   *  distinct testIDs or an automated tap cannot say which one it hit. */
  idPrefix?: string;
}) {
  // Three tiers, one axis. A command's human title stays at the quiet floor;
  // the path a mutation changed lifts one step; a failure lifts all the way.
  // Luminance is the only escalation left once the accent is spent on live
  // state, so this is the one place tone and persistence deliberately double
  // up — a failure both keeps its line and is the brightest thing on it.
  const tone =
    action.weight === 'failure'
      ? styles.mechanismLabelFailed
      : action.weight === 'mutation'
        ? styles.mechanismLabelLifted
        : undefined;
  return (
    <Pressable
      accessibilityLabel={`Inspect ${action.weight} ${action.path ?? action.title}`}
      accessibilityRole="button"
      onPress={onPress}
      style={styles.mechanismRow}
      testID={`${idPrefix}-${action.id}`}
    >
      <Text style={styles.mechanismGlyph}>{ROW_GLYPH[action.weight]}</Text>
      <Text
        numberOfLines={1}
        style={[styles.mechanismLabel, tone]}
      >
        {action.title}
      </Text>
      {action.weight === 'failure' ? (
        <Text style={styles.mechanismMeta}>FAILED</Text>
      ) : action.files?.length ? (
        <Text style={styles.mechanismMeta}>
          {action.files.length} {action.files.length === 1 ? 'FILE' : 'FILES'}
        </Text>
      ) : action.status ? (
        <Text style={styles.mechanismMeta}>{action.status.toUpperCase()}</Text>
      ) : null}
    </Pressable>
  );
}

/**
 * `5.8` — one decimal, the way grok writes it (`Thought for 5.8s`). Seconds is
 * the only unit that fits: a receipt in milliseconds reports the machine, and a
 * receipt in whole seconds loses the difference between a beat and a stall.
 */
function thoughtSeconds(ms: number): string {
  return (ms / 1000).toFixed(1);
}

/**
 * The counted note, in the tense that matches its state.
 *
 * This is the row that closes the corner's research dead-air. A turn that is
 * nothing but reads and searches produces no mutation, no command, and no
 * mechanism row — and used to produce no row at all, so the corner sat silent
 * through exactly the stretch where the agent was busiest. Body now tallies
 * those calls onto the batch receipt it was already publishing, and this is
 * where the tally lands: one line, dimmest tier, no box, saying how many calls
 * and of what kind.
 *
 * Live, it reads `12 TOOL CALLS · reading 8, searching 3` beside a breathing
 * gold rail; settled, it demotes to the past tense and the rail goes quiet.
 * Memoized because the corner re-renders it on every presence tick.
 */
const ActivityNote = React.memo(function ActivityNote({
  handle,
  live,
  onPress,
  showHandle,
  text,
  thoughtMs,
}: {
  handle?: string;
  live: boolean;
  onPress: () => void;
  showHandle: boolean;
  /** Absent when the only thing this turn left behind is the receipt below. */
  text?: string;
  thoughtMs?: number;
}) {
  return (
    <HullMechanismReveal live={live}>
      <Pressable
        accessibilityLabel={text ? `${text}. Review the calls` : 'Review this turn'}
        accessibilityRole="button"
        onPress={onPress}
        style={styles.noteRow}
        testID="activity-tool-note"
      >
        <HullMechanismRail live={live} />
        {/* One line, dimmest tier, no box: this row repeats once per turn,
            and a repeating content unit never earns a frame. The label
            truncates; the disclosure never does, because the affordance is
            the reason the line exists. */}
        {text ? (
          <Text numberOfLines={1} style={[styles.noteText, live && styles.noteTextLive]}>
            ⋯ {showHandle && handle ? `${handle.toUpperCase()} · ` : ''}
            {text}
          </Text>
        ) : null}
        {/* The quiet half of grok's loud-then-quiet reasoning. It is only ever
            a receipt: by the time it renders, the thinking is over — which is
            precisely when grok collapses its own live `Thinking…` block to the
            same five words. */}
        {thoughtMs ? (
          <Text style={styles.noteReceipt} testID="activity-thought-receipt">
            {text ? '· ' : ''}THOUGHT {thoughtSeconds(thoughtMs)}S
          </Text>
        ) : null}
        <Text style={styles.noteAffordance}> ›</Text>
        {live ? <HullActivityTip /> : null}
      </Pressable>
    </HullMechanismReveal>
  );
});

/**
 * A turn, read the way it was worked: narration first, tools as footnotes.
 *
 * Three layers, in the order the eye should take them:
 *
 *   1. **Narration** — the agent's own prose, full width, ledger tier, no
 *      glyph, no indent, and never behind a disclosure. This is the spine; a
 *      reader who reads only these lines understands the whole turn. It used to
 *      be swept into the tool-output fold with everything else, which is how an
 *      agent's own words ended up hidden behind "tap to expand".
 *   2. **Mechanism rows** — one line each for the calls that executed, mutated,
 *      or failed. These are the payload of the turn, so they stay on the slab.
 *   3. **One counted note** — every read/search/list folded into a single
 *      verb-counted line. Not one collapsed line per call, and never a wall.
 *      Its raw output lives only behind the review sheet; its *meaning* reaches
 *      the reader through the narration above.
 *
 * Memoized: rendered once per activity row inside FlatList's renderItem, which
 * is recreated on every presence tick — without this, every activity row's
 * (already non-trivial) render re-executes on updates unrelated to that row's
 * own activity. `items` must stay reference-stable across unrelated re-renders
 * for this to pay off (see LedgerActivity).
 */
export const ActivityTimeline = React.memo(function ActivityTimeline({
  active = false,
  items,
  handle,
  testID,
}: ActivityTimelineProps) {
  const turn = useMemo(() => buildTurnActivity(items), [items]);
  const [reviewing, setReviewing] = useState(false);
  const [selected, setSelected] = useState<TurnActivityAction | null>(null);
  const [selectedFile, setSelectedFile] = useState<TurnActivityFile | null>(null);
  const insets = useSafeAreaInsets();

  // Newest first. The transcript's own FlatList is inverted, so walking a
  // finished turn backwards is the consistent gesture here, not a novelty: the
  // last thing the agent did is what you came to check, and scrolling down
  // walks back through the turn. Failures pin to the top regardless of
  // recency — a failure forty calls ago still outranks a read from two
  // seconds ago.
  const reviewRows = useMemo(() => {
    const rows = [...turn.observations].reverse();
    const failures = turn.actions.filter((action) => action.weight === 'failure');
    return [...failures, ...rows];
  }, [turn.actions, turn.observations]);

  // Tense follows state. A turn still in flight says what it *is* doing; a
  // finished one says what it did. Same row, same position, same width — grok
  // rewrites its rollup in place for exactly this reason, and moving the row
  // instead would cost the reader their place in the transcript.
  const noteCopy = active ? (turn.liveNote ?? turn.note) : turn.note;

  // A plan alone is NOT content for this row. The plan's home is the pinned
  // objective panel above the transcript (`CornerPlanPin`), and body now
  // publishes a plan change on its own `activity_summary` event — so counting
  // it here would print an otherwise-empty mechanism row in the transcript
  // every time the agent re-planned. It stays available inside this turn's
  // review sheet as the historical snapshot it always was.
  const hasContent =
    turn.narration.length > 0 ||
    turn.actions.length > 0 ||
    Boolean(turn.note) ||
    Boolean(turn.thoughtMs);
  if (!hasContent) return null;

  const closeReview = () => {
    setSelectedFile(null);
    setSelected(null);
    setReviewing(false);
  };

  const inspectAction = (action: TurnActivityAction) => {
    setSelectedFile(null);
    setSelected(action);
    setReviewing(true);
  };

  return (
    <View style={styles.timeline} testID={testID}>
      {/* The spine. Nothing between narration and the note below it — no
          spacer row, no divider, no timestamp line. */}
      {turn.narration.map((prose, index) => (
        <MonoMarkdown
          key={`narration-${index}`}
          markdown={prose}
          textStyle={styles.narration}
          leadingInline={
            index === 0 && handle ? (
              <Text style={styles.narrationHandle}>
                {handle.toUpperCase()}
                {'  '}
              </Text>
            ) : null
          }
          testID={index === 0 ? 'activity-narration' : undefined}
        />
      ))}

      {turn.actions.map((action) => (
        <MechanismRow key={action.id} action={action} onPress={() => inspectAction(action)} />
      ))}

      {noteCopy || turn.thoughtMs ? (
        <ActivityNote
          handle={handle}
          live={active}
          onPress={() => setReviewing(true)}
          showHandle={!turn.narration.length}
          text={noteCopy}
          thoughtMs={turn.thoughtMs}
        />
      ) : active ? (
        <View style={styles.noteRow}>
          <HullMechanismRail live />
          <HullActivityTip />
        </View>
      ) : null}

      {/* Bottom-up review. A full sheet rather than an inline expansion, so
          tapping the note never shifts the transcript out from under the
          reader — the thing they tapped is still on screen, as the header. */}
      <RNModal
        animationType="slide"
        onRequestClose={closeReview}
        transparent
        visible={reviewing}
      >
        <View style={[styles.reviewRoot, { paddingBottom: Math.max(insets.bottom, 12) }]}>
          <Pressable
            accessibilityLabel="Close tool call review"
            onPress={closeReview}
            style={StyleSheet.absoluteFill}
          />
          <HullSurface strength="raised" style={styles.reviewSheet} testID="activity-review-sheet">
            <View style={styles.reviewHeading}>
              <Text numberOfLines={2} style={styles.reviewTitle}>
                {turn.note ?? 'TOOL CALLS'}
              </Text>
              <Pressable
                accessibilityLabel="Close tool call review"
                accessibilityRole="button"
                onPress={closeReview}
                style={styles.reviewClose}
              >
                <Text style={styles.reviewCloseText}>×</Text>
              </Pressable>
            </View>
            {selected ? (
              <ActionDetail
                action={selected}
                file={selectedFile}
                onBack={() => {
                  if (selectedFile) setSelectedFile(null);
                  else setSelected(null);
                }}
                onSelectFile={setSelectedFile}
              />
            ) : (
              <ScrollView
                contentContainerStyle={styles.reviewContent}
                nestedScrollEnabled
                showsVerticalScrollIndicator={false}
              >
                {turn.plan ? <ObjectiveChecklist plan={turn.plan} /> : null}
                {reviewRows.map((action) => (
                  <MechanismRow
                    key={`review-${action.id}`}
                    action={action}
                    idPrefix="activity-review-action"
                    onPress={() => inspectAction(action)}
                  />
                ))}
                {!reviewRows.length && !turn.plan ? (
                  <Text style={styles.emptyDetail}>
                    These calls were counted but carried no detail of their own.
                  </Text>
                ) : null}
              </ScrollView>
            )}
          </HullSurface>
        </View>
      </RNModal>
    </View>
  );
});

const styles = StyleSheet.create((theme) => {
  const groknight = theme.buzz;
  return ({
  timeline: {
    width: '100%',
    minWidth: 0,
    paddingVertical: 4,
  },
  /**
   * The primary voice. Identical to a plain agent turn in the ledger — same
   * face, same size, same brightest tier, same halo — because it *is* one:
   * narration reaching the reader inside an activity event is still narration,
   * and nothing about its transport should change how it reads.
   */
  narration: {
    ...Typography.ledger(),
    width: '100%',
    minWidth: 0,
    color: groknight.ledgerBright,
    // ONE message size: narration is message text, so it matches the ledger
    // body exactly (Editorial direction — hierarchy by weight, not size).
    fontSize: 16,
    lineHeight: 25,
  },
  narrationHandle: {
    ...Typography.ledger('medium'),
    color: groknight.ledgerBright,
    fontSize: 16,
    lineHeight: 25,
    letterSpacing: -0.1,
  },
  objective: {
    marginBottom: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: groknight.borderQuiet,
  },
  objectiveEyebrow: {
    ...Typography.mono(),
    color: groknight.textMuted,
    fontSize: 9,
    lineHeight: 12,
    letterSpacing: 1,
  },
  objectiveTitle: {
    ...Typography.default(),
    color: groknight.textPrimary,
    fontSize: 13,
    lineHeight: 18,
    marginTop: 3,
    marginBottom: 6,
  },
  checklistRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 7, marginTop: 3 },
  checklistMark: {
    ...Typography.mono(),
    color: groknight.textSecondary,
    fontSize: 10,
    lineHeight: 15,
  },
  checklistText: {
    ...Typography.default(),
    flex: 1,
    minWidth: 0,
    color: groknight.textSecondary,
    fontSize: 11,
    lineHeight: 15,
  },
  checklistDone: { color: groknight.textMuted, textDecorationLine: 'line-through' },
  /**
   * Mechanism sits at a fixed indent so the reading column above it never
   * moves. No box: these repeat, and a repeating unit is separated by
   * whitespace and tone, never by an edge.
   */
  mechanismRow: {
    minHeight: 26,
    minWidth: 0,
    marginTop: 2,
    paddingLeft: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  mechanismGlyph: {
    ...Typography.mono(),
    width: 16,
    flexShrink: 0,
    color: groknight.ledgerGhost,
    fontSize: 10,
    lineHeight: 18,
  },
  mechanismLabel: {
    ...Typography.mono(),
    flexShrink: 1,
    minWidth: 0,
    color: groknight.ledgerQuiet,
    fontSize: 11,
    lineHeight: 18,
  },
  /** The thing that changed. Luminance, not hue — gold stays spent on live. */
  mechanismLabelLifted: { color: groknight.ledgerBody },
  /** A failure, one step above that: the only escalation the ledger has left. */
  mechanismLabelFailed: { color: groknight.ledgerBright },
  mechanismMeta: {
    ...Typography.mono(),
    flexShrink: 0,
    color: groknight.ledgerGhost,
    fontSize: 8,
    lineHeight: 18,
    letterSpacing: 0.8,
  },
  /**
   * The rail lives in the margin, not in the reading column: 4 + 2 + 6 puts
   * the label back at the same x=12 every other mechanism row uses, so turning
   * the rail on and off never reflows a word.
   */
  noteRow: {
    minHeight: 28,
    marginTop: 2,
    paddingLeft: 4,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  noteText: {
    ...Typography.mono(),
    flexShrink: 1,
    minWidth: 0,
    color: groknight.ledgerGhost,
    fontSize: 11,
    lineHeight: 20,
  },
  /**
   * Live copy lifts one step, and only one. The rail beside it is already
   * gold and already breathing; taking the label to the accent too would make
   * a research batch the loudest thing in the corner, which it is not.
   */
  noteTextLive: { color: groknight.ledgerQuiet },
  noteReceipt: {
    ...Typography.mono(),
    flexShrink: 0,
    color: groknight.ledgerGhost,
    fontSize: 8,
    lineHeight: 20,
    letterSpacing: 0.8,
  },
  noteAffordance: {
    ...Typography.mono(),
    flexShrink: 0,
    color: groknight.ledgerGhost,
    fontSize: 11,
    lineHeight: 20,
  },
  // ── The review sheet ────────────────────────────────────────────
  /** Bottom-up: it rises from the composer edge, where the tap came from.
   *  paddingBottom is set inline to the max of this floor and the device's
   *  safe-area inset, or the sheet's close button and last line sit under the
   *  Android system nav bar. */
  reviewRoot: {
    flex: 1,
    paddingHorizontal: 12,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(5, 5, 6, 0.84)',
  },
  /** A genuinely non-repeating region floating over the slab, so it earns one. */
  reviewSheet: {
    width: '100%',
    maxHeight: '78%',
    borderWidth: 1,
    borderColor: groknight.borderStrong,
  },
  reviewHeading: {
    minWidth: 0,
    paddingHorizontal: 12,
    paddingVertical: 10,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    borderBottomWidth: 1,
    borderBottomColor: groknight.borderQuiet,
  },
  reviewTitle: {
    ...Typography.mono(),
    flex: 1,
    minWidth: 0,
    color: groknight.textMuted,
    fontSize: 10,
    lineHeight: 15,
    letterSpacing: 0.8,
  },
  reviewClose: { width: 28, height: 28, alignItems: 'center', justifyContent: 'center' },
  reviewCloseText: {
    ...Typography.default(),
    color: groknight.textMuted,
    fontSize: 19,
    lineHeight: 23,
  },
  reviewContent: { paddingHorizontal: 6, paddingVertical: 8 },
  detailView: { minWidth: 0 },
  backRow: {
    minHeight: 34,
    justifyContent: 'center',
    paddingHorizontal: 10,
    borderBottomWidth: 1,
    borderBottomColor: groknight.borderQuiet,
  },
  backText: {
    ...Typography.mono(),
    color: groknight.textMuted,
    fontSize: 9,
    lineHeight: 12,
    letterSpacing: 0.6,
  },
  detailTitle: {
    ...Typography.mono(),
    color: groknight.textPrimary,
    fontSize: 11,
    lineHeight: 15,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  detailScroll: { maxHeight: 360 },
  fileRow: {
    minHeight: 36,
    minWidth: 0,
    paddingHorizontal: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderBottomWidth: 1,
    borderBottomColor: groknight.borderQuiet,
  },
  fileGlyph: {
    ...Typography.mono(),
    flexShrink: 0,
    color: groknight.ledgerQuiet,
    fontSize: 10,
    lineHeight: 16,
  },
  filePath: {
    ...Typography.mono(),
    flex: 1,
    minWidth: 0,
    color: groknight.textSecondary,
    fontSize: 10,
    lineHeight: 16,
  },
  detailBlock: { paddingHorizontal: 10, paddingBottom: 10 },
  detailLabel: {
    ...Typography.mono(),
    color: groknight.textMuted,
    fontSize: 8,
    lineHeight: 11,
    letterSpacing: 0.8,
    marginBottom: 4,
  },
  detailCode: {
    ...Typography.mono(),
    color: groknight.textSecondary,
    fontSize: 9,
    lineHeight: 13,
    padding: 8,
  },
  diffBody: { minWidth: '100%', paddingVertical: 4 },
  diffLine: {
    ...Typography.mono(),
    color: groknight.textSecondary,
    fontSize: 9,
    lineHeight: 14,
    paddingHorizontal: 8,
  },
  // Diffs are a deliberate color exception to Grok Mono Hull's zero-chroma
  // rule (captain override), same as ChangeReviewPanel.tsx's diff viewer —
  // share its tokens rather than hand-picking a second, slightly different
  // green/red pair. Hunk headers stay on the neutral grayscale palette.
  diffAdded: { backgroundColor: diffColors.addedBg, color: diffColors.addedBorder },
  diffRemoved: { backgroundColor: diffColors.removedBg, color: diffColors.removedBorder },
  diffHeader: { backgroundColor: groknight.bgHover, color: groknight.textMuted },
  emptyDetail: {
    ...Typography.default(),
    color: groknight.textMuted,
    fontSize: 11,
    lineHeight: 16,
    paddingHorizontal: 10,
    paddingVertical: 12,
  },
  });
});
