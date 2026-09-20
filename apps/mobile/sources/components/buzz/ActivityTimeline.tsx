import React, { useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { AgentActivityItem } from '@/sync/transport/rig-transport';
import { buildTurnActivity } from '@/buzz/activity-timeline';
import { formatToolCallDuration } from '@/buzz/tool-call-row';
import {
  groupToolLedgerRuns,
  toolGroupSummary,
  toolLedgerLines,
  type ToolLedgerLine,
  type ToolLedgerRun,
} from '@/buzz/tool-ledger';
import { BeelineMarkSpinner } from './BeelineMarkSpinner';
import { ToolOutputSheet } from './ToolOutputSheet';
import {
  LedgerBylineView,
  provisionalProseStyle,
  settledAgentProseStyle,
  type LedgerBylineMark,
} from './Ledger';
import { MonoMarkdown } from './MonoMarkdown';
import { StreamingProse } from './StreamingProse';

type ActivityTimelineProps = {
  active?: boolean;
  items: readonly AgentActivityItem[];
  handle?: string;
  /** Model text shown in the agent byline; defaults to the legacy role label. */
  role?: string;
  stamp?: string;
  testID?: string;
  messageDraft?: string;
  /** The streaming speaker's identity mark — the SAME mark the settled row's
   *  byline renders (`Ledger.LedgerBylineView`), so the draft lane carries the
   *  agent tile and the byline never moves when the draft settles. The words
   *  below it DO change: a draft is written in the provisional face and tone
   *  and cross-fades into the settled reply (C98). */
  mark?: LedgerBylineMark;
};

const OUTCOME_WORDS = {
  running: 'running',
  success: 'succeeded',
  failure: 'failed',
} as const;

function lineAccessibilityLabel(line: ToolLedgerLine): string {
  const parts = [line.label];
  if (line.kind !== 'thought') parts.push(OUTCOME_WORDS[line.outcome]);
  if (line.reason) parts.push(line.reason);
  return parts.join(', ');
}

/**
 * One ledger line (owner-approved design, 2026-08-24): family glyph, the
 * call's object, a quiet verdict, and a duration only when a receipt carried
 * one. The whole line is the tap target — it opens the full output sheet —
 * when the step has anything to show behind it.
 */
function ToolLedgerLineRow({
  line,
  onPress,
  testID,
}: {
  line: ToolLedgerLine;
  onPress?: () => void;
  testID?: string;
}) {
  const duration = formatToolCallDuration(line.durationMs);
  const showVerdict = line.kind !== 'thought';
  const accessibilityLabel = lineAccessibilityLabel(line);
  const row = (
    <>
      <Text accessibilityElementsHidden numberOfLines={1} style={styles.callGlyph}>
        {line.glyph}
      </Text>
      {/* Middle, not tail: a command's flags are the half that identifies it,
          and a narrow screen must cut the same place the data cap does. */}
      <Text ellipsizeMode="middle" numberOfLines={1} style={styles.callObject}>
        {line.label}
      </Text>
      {line.reason ? (
        <Text numberOfLines={1} style={styles.callReason}>
          {line.reason}
        </Text>
      ) : null}
      {duration ? (
        <Text accessibilityElementsHidden style={styles.callDuration}>
          {duration}
        </Text>
      ) : null}
      {showVerdict ? (
        line.outcome === 'running' ? (
          <View
            pointerEvents="none"
            style={styles.callVerdict}
            testID={`activity-verdict-${line.id}`}
          >
            <BeelineMarkSpinner live />
          </View>
        ) : (
          <Text
            accessibilityElementsHidden
            style={[
              styles.callVerdictText,
              line.outcome === 'failure' ? styles.callFailed : styles.callPassed,
            ]}
            testID={`activity-verdict-${line.id}`}
          >
            {line.outcome === 'failure' ? '✗' : '✓'}
          </Text>
        )
      ) : null}
    </>
  );
  if (!onPress) {
    return (
      <View accessibilityLabel={accessibilityLabel} style={styles.ledgerRow} testID={testID}>
        {row}
      </View>
    );
  }
  return (
    <Pressable
      accessibilityHint="Opens this call’s output"
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      accessibilityState={{ busy: line.outcome === 'running' }}
      onPress={onPress}
      style={styles.ledgerRow}
      testID={testID}
    >
      {row}
    </Pressable>
  );
}

/**
 * One collapsed machine-run summary — `⌄ 6 steps · 2 failed · 48s` —
 * that expands in place into its individual ledger lines.
 */
function ToolRunGroupRow({
  run,
  onPressLine,
}: {
  run: Extract<ToolLedgerRun, { kind: 'group' }>;
  onPressLine?: (line: ToolLedgerLine) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const duration = formatToolCallDuration(run.durationMs);
  const summary = toolGroupSummary(run.count, run.failed, run.durationMs);
  return (
    <View>
      <Pressable
        accessibilityHint={expanded ? 'Hides the steps' : 'Shows the steps'}
        accessibilityLabel={`${summary}, expandable`}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={() => setExpanded((value) => !value)}
        style={styles.groupRow}
        testID={`tool-run-group-${run.id}`}
      >
        <Text accessibilityElementsHidden style={styles.groupChevron}>
          {expanded ? '⌃' : '⌄'}
        </Text>
        <Text ellipsizeMode="middle" numberOfLines={1} style={styles.groupLabel}>
          {`${run.count} ${run.count === 1 ? 'step' : 'steps'}`}
          {run.failed ? <Text style={styles.groupFailed}>{` · ${run.failed} failed`}</Text> : null}
          {duration ? ` · ${duration}` : null}
        </Text>
      </Pressable>
      {expanded
        ? run.lines.map((line) => (
            <ToolLedgerLineRow
              key={line.id}
              line={line}
              onPress={line.detail ? () => onPressLine?.(line) : undefined}
              testID={`tool-ledger-line-${line.id}`}
            />
          ))
        : null}
    </View>
  );
}

/**
 * The live conversational turn: agent prose, and beneath it the one-line tool
 * ledger — one collapsed disclosure per agent turn, expanding to a line per
 * tool call, with every line that carries output opening the output sheet.
 */
export const ActivityTimeline = React.memo(function ActivityTimeline({
  active = false,
  handle,
  role = 'agent',
  items,
  stamp,
  testID,
  messageDraft,
  mark,
}: ActivityTimelineProps) {
  const turn = useMemo(() => buildTurnActivity(items), [items]);
  const runs = useMemo(
    () => groupToolLedgerRuns(toolLedgerLines(turn.steps, active)),
    [turn, active],
  );
  const [sheetLine, setSheetLine] = useState<ToolLedgerLine | null>(null);
  // The provisional face and tone, plus this lane's own spacing. One object,
  // memoised, so the markdown renderer's identity check still bails out.
  const draftTextStyle = useMemo(
    () => ({ ...provisionalProseStyle(), ...styles.messageDraft }),
    [],
  );
  // A lane with nothing in it at all renders nothing.
  //
  // A RETRACTED draft is deliberately included (C98). When a turn fails the
  // lane stops being live but the words the reader was reading stay on the
  // page, provisional, with the server's failure line beneath them — text a
  // person was mid-way through must never evaporate on its own.
  if (!turn.narration.length && !runs.length && !messageDraft) return null;

  return (
    <View style={styles.timeline} testID={testID}>
      {handle ? (
        <LedgerBylineView byline={{ name: handle, role, stamp: stamp ?? '', mark }} />
      ) : null}
      {turn.narration.map((narration, index) => (
        <MonoMarkdown
          key={`${index}:${narration}`}
          markdown={narration}
          textStyle={settledAgentProseStyle()}
          testID={`activity-narration-${index}`}
        />
      ))}
      {runs.map((run) => (
        <ToolRunGroupRow key={run.id} onPressLine={setSheetLine} run={run} />
      ))}
      {messageDraft ? (
        <StreamingProse
          markdown={messageDraft}
          textStyle={draftTextStyle}
          testID="activity-message-draft"
        />
      ) : null}
      <ToolOutputSheet
        detail={sheetLine?.detail}
        onClose={() => setSheetLine(null)}
        subtitle={sheetLine?.outcome === 'failure' ? sheetLine?.reason : undefined}
        title={sheetLine?.label ?? 'Output'}
        visible={Boolean(sheetLine?.detail)}
      />
    </View>
  );
});

const styles = StyleSheet.create((theme) => {
  const groknight = theme.buzz;
  return {
    timeline: { width: '100%', minWidth: 0, paddingVertical: 4 },
    // Spacing only. The face and the tone are the ledger's one provisional
    // definition (`Ledger.provisionalProseStyle`), so a draft and the reply
    // that settles it are the same words in the same column (C98).
    messageDraft: { marginTop: 2 },
    // The whole line is the tap target; 44 keeps every ledger line inside the
    // comfortable minimum touch size.
    ledgerRow: {
      minHeight: 44,
      minWidth: 0,
      justifyContent: 'center',
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: groknight.borderQuiet,
      paddingHorizontal: groknight.space.xs,
      flexDirection: 'row',
      alignItems: 'center',
      gap: groknight.space.sm,
    },
    // A fixed glyph column, so every label starts on one line even though
    // `>_` is two characters wide and the rest are one.
    callGlyph: {
      ...groknight.type.machine,
      width: 24,
      flexShrink: 0,
      color: groknight.ledgerGhost,
    },
    callObject: {
      ...groknight.type.machine,
      flex: 1,
      minWidth: 48,
      color: groknight.ledgerBody,
    },
    // The distilled failure reason, dimmer than the label — a quiet inline
    // sentence, never a chip.
    callReason: {
      ...groknight.type.machine,
      flexShrink: 1,
      minWidth: 0,
      color: groknight.ledgerQuiet,
    },
    callDuration: {
      ...groknight.type.machine,
      flexShrink: 0,
      color: groknight.ledgerGhost,
      fontVariant: ['tabular-nums'],
    },
    callVerdict: { width: 18, flexShrink: 0, alignItems: 'flex-end' },
    callVerdictText: {
      ...groknight.type.machine,
      width: 18,
      flexShrink: 0,
      textAlign: 'right',
    },
    // The two places colour is spent here: brass for needs-attention (the
    // failure cross), the dimmest chrome for the success tick.
    callFailed: { color: groknight.accent },
    callPassed: { color: groknight.ledgerGhost },
    groupRow: {
      minHeight: 44,
      minWidth: 0,
      justifyContent: 'center',
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: groknight.borderQuiet,
      paddingHorizontal: groknight.space.xs,
      flexDirection: 'row',
      alignItems: 'center',
      gap: groknight.space.sm,
    },
    groupChevron: {
      ...groknight.type.machine,
      width: 24,
      flexShrink: 0,
      color: groknight.ledgerGhost,
    },
    groupLabel: {
      ...groknight.type.machine,
      flex: 1,
      minWidth: 0,
      color: groknight.ledgerQuiet,
    },
    groupFailed: { color: groknight.accent },
  };
});
