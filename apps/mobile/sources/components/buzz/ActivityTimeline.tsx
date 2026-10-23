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
  ledgerEntryRhythm,
  provisionalProseStyle,
  settledAgentProseStyle,
  type LedgerBylineMark,
} from './Ledger';
import { MonoMarkdown } from './MonoMarkdown';
import { StreamingProse } from './StreamingProse';
import { LedgerDisclosure, LedgerLogGroup } from './LedgerDisclosure';
import { InlineRow, TranscriptNavigationRow } from './IndexRow';

type ActivityTimelineProps = {
  active?: boolean;
  items: readonly AgentActivityItem[];
  handle?: string;
  /** Model text shown in the agent byline; defaults to the legacy role label. */
  role?: string;
  stamp?: string;
  /** Desktop transcripts flow chronologically; phone transcripts are inverted. */
  chronological?: boolean;
  testID?: string;
  messageDraft?: string;
  messageDraftKey?: string;
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
  if (line.kind === 'note') return `Note: ${line.label}`;
  const parts = [line.label];
  if (line.kind !== 'thought') parts.push(OUTCOME_WORDS[line.outcome]);
  if (line.reason) parts.push(line.reason);
  return parts.join(', ');
}

/**
 * Shared transcript child row: action, machine object and recorded duration.
 * The whole row opens the output sheet when the call carries detail.
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
  const showVerdict = line.kind === 'tool';
  const accessibilityLabel = lineAccessibilityLabel(line);
  if (line.kind === 'note') {
    // Text the agent wrote before a later tool call. It is not the reply, but
    // it is the agent's own words, so it is shown whole — never cut to a line.
    return (
      <View accessibilityLabel={accessibilityLabel} style={styles.noteRow} testID={testID}>
        <Text accessibilityElementsHidden style={styles.callGlyph}>
          {line.glyph}
        </Text>
        <View style={styles.noteBody}>
          <MonoMarkdown markdown={line.label} textStyle={styles.noteText} />
        </View>
      </View>
    );
  }
  const action = line.verb ?? (line.glyph === '>_' ? 'ran' : line.glyph === '≡' ? 'read' : 'used');
  const verb = line.outcome === 'failure' ? 'Failed' : line.outcome === 'running' ? 'Running' : action.charAt(0).toUpperCase() + action.slice(1);
  return (
    <TranscriptNavigationRow testID={testID} singleDestination
      trailing={onPress ? { onPress, accessibilityLabel, accessibilityRole: 'button',
        accessibilityState: { busy: line.outcome === 'running' },
        accessibilityHint: 'Opens this call’s output' } : undefined}>
      <InlineRow style={styles.toolCopy}>
        <Text style={[styles.toolVerb, line.outcome === 'failure' && styles.groupFailed]}>{verb}</Text>
        <Text ellipsizeMode="middle" numberOfLines={1} style={styles.callObject}>{line.label}</Text>
        {line.reason ? <Text numberOfLines={1} style={styles.callReason}>{line.reason}</Text> : null}
        {duration ? <Text style={styles.callDuration}>{duration}</Text> : null}
        {showVerdict && line.outcome === 'running' ? <View testID={`activity-verdict-${line.id}`}><BeelineMarkSpinner live /></View> : null}
      </InlineRow>
    </TranscriptNavigationRow>
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
  const [showAll, setShowAll] = useState(false);
  const duration = formatToolCallDuration(run.durationMs);
  const summary = toolGroupSummary(run.count, run.failed, run.durationMs, run.notes);
  const steps = run.count > 0 || run.notes === 0;
  return (
    <LedgerLogGroup testID={`tool-run-container-${run.id}`}>
      <LedgerDisclosure expanded={expanded} onPress={() => { if (expanded) setShowAll(false); setExpanded(value => !value); }}
        accessibilityLabel={`${summary}, expandable`} accessibilityState={{ expanded }} rowTestID={`tool-run-group-${run.id}`}>
        {steps ? `${run.count} ${run.count === 1 ? 'step' : 'steps'}` : null}
        {run.failed ? <Text style={styles.groupFailed}>{` · ${run.failed} failed`}</Text> : null}
        {run.notes ? `${steps ? ' · ' : ''}${run.notes} ${run.notes === 1 ? 'note' : 'notes'}` : null}
        {duration ? ` · ${duration}` : null}
      </LedgerDisclosure>
      {expanded
        ? (showAll || run.lines.length <= 3 ? run.lines : run.lines.slice(0, 2)).map((line) => (
            <ToolLedgerLineRow
              key={line.id}
              line={line}
              onPress={line.detail ? () => onPressLine?.(line) : undefined}
              testID={`tool-ledger-line-${line.id}`}
            />
          ))
        : null}
      {expanded && !showAll && run.lines.length > 3 ? <LedgerDisclosure
        expanded={false} accessibilityState={{ expanded: false }}
        accessibilityLabel={`${run.lines.length - 2} more steps`} onPress={() => setShowAll(true)}
        rowTestID={`tool-run-more-${run.id}`}>
        {run.lines.length - 2} more
      </LedgerDisclosure> : null}
    </LedgerLogGroup>
  );
}

/**
 * A settled reply's steps line: the turn's tool calls and the text it wrote
 * before its final answer, folded into one collapsed `ToolRunGroupRow` under
 * the reply. Renders nothing when the reply carries no steps.
 */
export const TurnStepsLine = React.memo(function TurnStepsLine({
  items,
  testID,
}: {
  items: readonly AgentActivityItem[];
  testID?: string;
}) {
  const runs = useMemo(
    () => groupToolLedgerRuns(toolLedgerLines(buildTurnActivity(items).steps)),
    [items],
  );
  const [sheetLine, setSheetLine] = useState<ToolLedgerLine | null>(null);
  if (!runs.length) return null;
  return (
    <View testID={testID}>
      {runs.map((run) => (
        <ToolRunGroupRow key={run.id} onPressLine={setSheetLine} run={run} />
      ))}
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
  chronological = false,
  testID,
  messageDraft,
  messageDraftKey,
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
  if (!turn.narration.length && !runs.length && !messageDraft && !messageDraftKey) return null;

  return (
    <View style={ledgerEntryRhythm({ hasByline: Boolean(handle), chronological })} testID={testID}>
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
      {messageDraft || messageDraftKey ? (
        <StreamingProse
          {...(messageDraftKey ? { streamKey: messageDraftKey } : { markdown: messageDraft! })}
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
    // Spacing only. The face and the tone are the ledger's one provisional
    // definition (`Ledger.provisionalProseStyle`), so a draft and the reply
    // that settles it are the same words in the same column (C98).
    toolCopy: { flexDirection: 'row', alignItems: 'center', gap: groknight.space.sm },
    toolVerb: { ...groknight.type.meta, color: groknight.textPrimary },
    messageDraft: { marginTop: groknight.space.xs },
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
      ...groknight.type.meta,
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
    // A note wraps to its full length, so it keeps the ledger line's hairline
    // and gutter but not its fixed one-line height.
    noteRow: {
      minHeight: 44,
      minWidth: 0,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: groknight.borderQuiet,
      paddingHorizontal: groknight.space.xs,
      paddingVertical: groknight.space.sm,
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: groknight.space.sm,
    },
    noteBody: { flex: 1, minWidth: 0 },
    noteText: { ...groknight.type.meta, color: groknight.ledgerBody },
    groupFailed: { color: groknight.accent },
  };
});
