import React, { useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { AgentActivityItem } from '@/sync/transport/rig-transport';
import { buildTurnActivity, type TurnActivityAction } from '@/buzz/activity-timeline';
import {
  toolCallRow,
  TOOL_CALL_OUTPUT_LINES,
  type ToolCallRow,
} from '@/buzz/tool-call-row';
import { Typography } from '@/constants/Typography';
import { LedgerBylineView, type LedgerBylineMark } from './Ledger';
import { MonoMarkdown } from './MonoMarkdown';

type ActivityTimelineProps = {
  active?: boolean;
  items: readonly AgentActivityItem[];
  handle?: string;
  stamp?: string;
  testID?: string;
  messageDraft?: string;
  /** The streaming speaker's identity mark — the SAME mark the settled row's
   *  byline renders (`Ledger.LedgerBylineView`), so the draft lane carries the
   *  agent triangle and nothing changes visually when the draft settles. */
  mark?: LedgerBylineMark;
};

/**
 * One expanded tool call, one line: verb, object, and — only when it is not the
 * ordinary case — a duration and an outcome word (C88).
 *
 * Success says nothing at all; absence reads faster than a tick. A failed call
 * arrives already open, because the one thing a reader expands this group for
 * is the call that did not work.
 */
function ToolCallLine({ row }: { row: ToolCallRow }) {
  const [expanded, setExpanded] = useState(row.outcome === 'failure');
  const [allLines, setAllLines] = useState(false);
  const shown = allLines ? row.output : row.output.slice(0, TOOL_CALL_OUTPUT_LINES);
  const hidden = row.output.length - shown.length;
  const hasDetail = Boolean(row.output.length || row.reason || row.files.length || row.requestedBy);
  const accessibilityLabel = [
    `${row.verb} ${row.object}`,
    row.outcome === 'failure' ? 'failed' : row.outcome === 'running' ? 'running' : 'succeeded',
    row.reason,
  ]
    .filter(Boolean)
    .join(', ');
  const line = (
    <>
      <View style={styles.callRow}>
        <Text numberOfLines={1} style={styles.callVerb}>
          {row.verb}
        </Text>
        {/* Middle, not tail: a command's flags are the half that identifies it,
            and a narrow screen must cut the same place the data cap does. */}
        <Text ellipsizeMode="middle" numberOfLines={1} style={styles.callObject}>
          {row.object}
        </Text>
        {row.duration ? (
          <Text accessibilityElementsHidden style={styles.callDuration}>
            {row.duration}
          </Text>
        ) : null}
        {row.outcome === 'success' ? null : (
          <Text
            accessibilityElementsHidden
            style={[
              styles.callOutcome,
              row.outcome === 'failure' ? styles.callFailed : styles.callRunning,
            ]}
            testID={`activity-verdict-${row.id}`}
          >
            {row.outcome === 'failure' ? 'failed' : 'running'}
          </Text>
        )}
      </View>
      {expanded && hasDetail ? (
        <View style={styles.callDetail} testID={`corner-tool-row-detail-${row.id}`}>
          {row.reason ? <Text style={[styles.detailLine, styles.detailFailed]}>{row.reason}</Text> : null}
          {row.files.map((file) => (
            <Text key={`${row.id}:file:${file.path}`} style={styles.detailLine}>
              {file.status ? `${file.status} ${file.path}` : file.path}
            </Text>
          ))}
          {shown.map((output, index) => (
            <Text key={`${row.id}:out:${index}`} style={styles.detailLine}>
              {output}
            </Text>
          ))}
          {hidden > 0 ? (
            <Pressable
              accessibilityLabel={`Show ${hidden} more output lines`}
              accessibilityRole="button"
              onPress={() => setAllLines(true)}
              testID={`corner-tool-row-more-${row.id}`}
            >
              <Text style={styles.detailMore}>{`+${hidden} more lines`}</Text>
            </Pressable>
          ) : null}
          {row.requestedBy ? (
            <Text style={styles.detailLine}>
              {`at ${row.requestedBy.name ?? row.requestedBy.pubkey.slice(0, 12)}'s request`}
            </Text>
          ) : null}
        </View>
      ) : null}
    </>
  );
  if (!hasDetail) return <View testID={`corner-tool-row-${row.id}`}>{line}</View>;
  return (
    <Pressable
      accessibilityHint={expanded ? 'Collapses this call' : 'Shows this call’s output'}
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      accessibilityState={{ busy: row.outcome === 'running', expanded }}
      onPress={() => setExpanded((value) => !value)}
      style={styles.callDisclosure}
      testID={`corner-tool-row-${row.id}`}
    >
      {line}
    </Pressable>
  );
}

function activitySummary(rows: readonly ToolCallRow[], active: boolean): string {
  const count = rows.length;
  const failures = rows.filter((row) => row.outcome === 'failure').length;
  const head = `${count} TOOL ${count === 1 ? 'CALL' : 'CALLS'}`;
  if (failures) return `${head} · ${failures} FAILED`;
  return active ? `${head} · WORKING` : head;
}

/**
 * The live conversational turn. One compact mechanism row sits between prose
 * outputs; it expands on demand into one line per call, and each of those opens
 * onto its own real output. Three levels: fold, line, detail.
 */
export const ActivityTimeline = React.memo(function ActivityTimeline({
  active = false,
  handle,
  items,
  stamp,
  testID,
  messageDraft,
  mark,
}: ActivityTimelineProps) {
  const turn = useMemo(() => buildTurnActivity(items), [items]);
  const rows = useMemo(() => {
    const steps = turn.steps.filter((step: TurnActivityAction) => step.kind === 'tool');
    return steps.map((step, index) => toolCallRow(step, active && index === steps.length - 1));
  }, [turn, active]);
  const [expanded, setExpanded] = useState(false);
  // Settled turns keep their collapsed tool rows (#804); only an empty live
  // lane (no steps, no draft) renders nothing.
  if (!rows.length && !(active && messageDraft)) return null;

  return (
    <View style={styles.timeline} testID={testID}>
      {handle ? (
        <LedgerBylineView
          byline={{ name: handle, role: 'agent', stamp: stamp ?? '', mark }}
        />
      ) : null}
      {rows.length ? (
        <>
          <Pressable
            accessibilityHint={expanded ? 'Hides individual tool calls' : 'Shows individual tool calls'}
            accessibilityLabel={activitySummary(rows, active)}
            accessibilityRole="button"
            accessibilityState={{ busy: active, expanded }}
            onPress={() => setExpanded((value) => !value)}
            style={styles.summaryDisclosure}
            testID="corner-tool-summary"
          >
            <Text style={styles.summaryLabel}>{activitySummary(rows, active)}</Text>
            <Text accessibilityElementsHidden style={styles.disclosureGlyph}>{expanded ? '⌃' : '⌄'}</Text>
          </Pressable>
          {expanded ? rows.map((row) => <ToolCallLine key={row.id} row={row} />) : null}
        </>
      ) : null}
      {messageDraft ? (
        <MonoMarkdown
          markdown={messageDraft}
          textStyle={styles.messageDraft}
          testID="activity-message-draft"
        />
      ) : null}
    </View>
  );
});

/** Seven mono characters — `deleted`, `fetched` — and the object column is straight. */
const VERB_COLUMN = 56;

const styles = StyleSheet.create((theme) => {
  const groknight = theme.buzz;
  return {
    timeline: { width: '100%', minWidth: 0, paddingVertical: 4 },
    messageDraft: {
      ...Typography.ledger(),
      color: groknight.ledgerBright,
      fontSize: 16,
      lineHeight: 25,
      marginTop: 2,
    },
    callDisclosure: {
      minWidth: 0,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: groknight.borderQuiet,
    },
    summaryDisclosure: {
      minHeight: 32,
      paddingHorizontal: 4,
      flexDirection: 'row',
      alignItems: 'center',
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: groknight.borderQuiet,
    },
    summaryLabel: {
      ...Typography.mono('semiBold'),
      flex: 1,
      minWidth: 0,
      color: groknight.ledgerQuiet,
      fontSize: 11,
      lineHeight: 18,
    },
    callRow: {
      minWidth: 0,
      paddingHorizontal: groknight.space.xs,
      paddingVertical: groknight.space.xs,
      flexDirection: 'row',
      alignItems: 'baseline',
      gap: groknight.space.sm,
    },
    // A fixed narrow column, so every object in the group starts on one line.
    callVerb: {
      ...Typography.mono(),
      width: VERB_COLUMN,
      flexShrink: 0,
      color: groknight.ledgerGhost,
      fontSize: groknight.type.machine.fontSize,
      lineHeight: groknight.type.machine.lineHeight,
    },
    callObject: {
      ...Typography.mono(),
      flex: 1,
      minWidth: 48,
      color: groknight.ledgerBody,
      fontSize: groknight.type.machine.fontSize,
      lineHeight: groknight.type.machine.lineHeight,
    },
    callDuration: {
      ...Typography.mono(),
      flexShrink: 0,
      color: groknight.ledgerGhost,
      fontSize: groknight.type.machine.fontSize,
      lineHeight: groknight.type.machine.lineHeight,
      fontVariant: ['tabular-nums'],
    },
    callOutcome: {
      ...Typography.mono(),
      flexShrink: 0,
      fontSize: groknight.type.machine.fontSize,
      lineHeight: groknight.type.machine.lineHeight,
    },
    // The two places colour is spent here: red for a failure, brass in flight.
    callFailed: { color: groknight.diffRemoved },
    callRunning: { color: groknight.accent },
    disclosureGlyph: {
      ...Typography.mono(),
      flexShrink: 0,
      color: groknight.ledgerGhost,
      fontSize: 10,
      lineHeight: 18,
    },
    callDetail: {
      paddingLeft: VERB_COLUMN + groknight.space.sm + groknight.space.xs,
      paddingRight: groknight.space.xs,
      paddingBottom: groknight.space.sm,
    },
    detailLine: {
      ...Typography.mono(),
      color: groknight.ledgerGhost,
      fontSize: 10,
      lineHeight: 15,
      marginBottom: 2,
    },
    detailFailed: { color: groknight.diffRemoved },
    detailMore: {
      ...Typography.mono(),
      color: groknight.ledgerQuiet,
      fontSize: 10,
      lineHeight: 15,
      marginBottom: 2,
    },
  };
});
