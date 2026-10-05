import React, { useMemo, useState } from 'react';
import { Linking, Pressable, Text, View } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';
import { StyleSheet } from 'react-native-unistyles';
import type {
  WorkflowActorView,
  WorkflowOpenedCornerView,
  WorkflowRunDetailView,
} from '@beeline/api-contract/phone';
import {
  workflowRunLine,
  workflowStateLabel,
  type WorkflowLineStatus,
  type WorkflowLineStep,
} from '@/buzz/workflow-graph';
import {
  formatRunDuration,
  stepSeconds,
  workflowStepAssignee,
  workflowStepMeta,
} from '@/buzz/workflow-run-copy';
import { identityPalette, isGeneratedAgentAvatarUrl } from '@/buzz/identity-mark';
import { previewHandle } from '@/buzz/room-list-row';
import { CORNER_META_SIZE, CornerGlyph } from './CornerGlyph';
import { DECORATIVE_GLYPH_PROPS } from './decorative-glyph';
import { IdentityMark } from './IdentityMark';
import { provisionalProseStyle, settledAgentProseStyle } from './Ledger';
import { HullLivePulse } from './MonoHull';

const CLOCK = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

const CIRCLE = 20;
const HALO = 32;
/** The circle's top within a step row, and the line's x (the circle's centre). */
const CIRCLE_TOP = 8;
const LINE_X = 28;
/** Where a step's copy column starts, right of the rail and its halo. */
const COPY_X = 56;
/** The assignee's mark: the step circle's size, so the row keeps one height. */
const ASSIGNEE_MARK = CIRCLE;

/** The status in words, for a screen reader: the circle's shape and tone say it to the eye. */
const STATUS_WORD: Record<WorkflowLineStatus, string> = {
  done: 'done',
  current: 'current step',
  pending: 'not yet reached',
  failed: 'failed',
};

const reached = (step: WorkflowLineStep) =>
  step.status === 'done' || step.status === 'current' || step.status === 'failed';

type SegmentTone = 'brass' | 'quiet';

/** Brass where the run went, quiet ahead. */
function segmentTone(above: WorkflowLineStep, below: WorkflowLineStep): SegmentTone {
  return reached(above) && reached(below) ? 'brass' : 'quiet';
}

/** One step's circle: brass check, breathing brass ring, hollow, or ink x. */
export function WorkflowStepCircle({
  status,
  size = CIRCLE,
  testID,
}: {
  status: WorkflowLineStatus;
  size?: number;
  testID?: string;
}) {
  const { brass, ground, hollow, ink } = palette();
  return (
    <Svg
      {...DECORATIVE_GLYPH_PROPS}
      height={size}
      testID={testID}
      viewBox="0 0 20 20"
      width={size}
    >
      {status === 'done' ? (
        <>
          <Circle cx={10} cy={10} fill={brass} r={9} />
          <Path
            d="M6 10.2l2.6 2.6L14 7.4"
            fill="none"
            stroke={ground}
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2.2}
          />
        </>
      ) : status === 'current' ? (
        <>
          <Circle cx={10} cy={10} fill={ground} r={8.25} stroke={brass} strokeWidth={1.5} />
          <Circle cx={10} cy={10} fill={brass} r={4} />
        </>
      ) : status === 'failed' ? (
        <>
          <Circle cx={10} cy={10} fill={ground} r={8.25} stroke={ink} strokeWidth={1.5} />
          <Path d="M7 7l6 6M13 7l-6 6" stroke={ink} strokeLinecap="round" strokeWidth={1.6} />
        </>
      ) : (
        <Circle cx={10} cy={10} fill={ground} r={8} stroke={hollow} strokeWidth={1.5} />
      )}
    </Svg>
  );
}

function palette() {
  return {
    brass: styles.brass.color,
    quiet: styles.quietLine.color,
    ground: styles.ground.color,
    hollow: styles.hollow.color,
    ink: styles.ink.color,
  };
}

/** A 2pt piece of the line, solid brass or quiet. */
function Segment({ tone, style, testID }: { tone: SegmentTone; vertical: boolean; style: object; testID?: string }) {
  const { brass, quiet } = palette();
  return <View style={[style, { backgroundColor: tone === 'brass' ? brass : quiet }]}
    testID={testID ? `${testID}-${tone}` : undefined} />;
}

/**
 * Every step of the workflow, one row each: done steps, the current step with
 * its live narration, and upcoming steps dimmed. The page reads the run;
 * decisions stay on the choice cards in the Room.
 */
export function WorkflowRunLine({
  detail,
  now,
  liveDrafts,
  onOpenCorner,
  testID = 'workflow-run-line',
}: {
  detail: WorkflowRunDetailView;
  now: number;
  /** Newest chunks keyed by agent id and turn request id. */
  liveDrafts?: ReadonlyMap<string, string>;
  onOpenCorner: (corner: WorkflowOpenedCornerView) => void;
  testID?: string;
}) {
  const line = useMemo(
    () => workflowRunLine(detail.contract, detail.history, detail.run.status),
    [detail.contract, detail.history, detail.run.status],
  );
  return (
    <View style={styles.list} testID={testID}>
      {line.map((step, index) => (
        <StepRow
          above={index > 0 ? segmentTone(line[index - 1]!, step) : undefined}
          below={index < line.length - 1 ? segmentTone(step, line[index + 1]!) : undefined}
          detail={detail}
          key={step.visitId ?? step.state}
          liveDrafts={liveDrafts}
          now={now}
          onOpenCorner={onOpenCorner}
          step={step}
          testID={`${testID}-step-${step.state}${line.slice(0, index).some((previous) => previous.state === step.state) ? `-visit-${index}` : ''}`}
        />
      ))}
    </View>
  );
}

/** The step's holder at the row's right: their mark and handle, brass when it is the viewer. */
function Assignee({
  actor,
  viewer,
  testID,
}: {
  actor: WorkflowActorView;
  viewer: boolean;
  testID: string;
}) {
  const hue =
    viewer || (actor.kind === 'agent' && isGeneratedAgentAvatarUrl(actor.avatar))
      ? styles.brass
      : { color: identityPalette(actor.id, actor.kind).mid };
  return (
    // The row's own label already names the assignee.
    <View
      accessibilityElementsHidden
      aria-hidden
      importantForAccessibility="no-hide-descendants"
      style={styles.assignee}
      testID={`${testID}-assignee${viewer ? '-viewer' : ''}`}
    >
      <IdentityMark
        avatarUrl={actor.avatar}
        face={actor.face}
        kind={actor.kind}
        name={actor.name}
        seed={actor.id}
        size={ASSIGNEE_MARK}
        testID={`${testID}-assignee-mark`}
      />
      <Text numberOfLines={1} style={[styles.handle, hue]} testID={`${testID}-assignee-handle`}>
        {`@${previewHandle(actor)}`}
      </Text>
    </View>
  );
}

function OpenedCorners({
  corners,
  onOpenCorner,
  testID,
}: {
  corners: readonly WorkflowOpenedCornerView[];
  onOpenCorner: (corner: WorkflowOpenedCornerView) => void;
  testID: string;
}) {
  return (
    <View style={styles.corners} testID={`${testID}-corners`}>
      {corners.map((corner) => (
        <Pressable
          accessibilityLabel={`Open corner ${corner.name}`}
          accessibilityRole="link"
          key={corner.id}
          onPress={() => onOpenCorner(corner)}
          style={({ pressed }) => [styles.cornerLink, pressed && styles.pressed]}
          testID={`workflow-run-corner-${corner.id}`}
        >
          <CornerGlyph size={CORNER_META_SIZE} />
          <Text numberOfLines={1} style={styles.cornerName}>
            {corner.name}
          </Text>
          <Text style={styles.cornerArrow}>→</Text>
        </Pressable>
      ))}
    </View>
  );
}

function StepRow({
  step,
  detail,
  now,
  liveDrafts,
  above,
  below,
  onOpenCorner,
  testID,
}: {
  step: WorkflowLineStep;
  detail: WorkflowRunDetailView;
  now: number;
  liveDrafts?: ReadonlyMap<string, string>;
  above?: SegmentTone;
  below?: SegmentTone;
  onOpenCorner: (corner: WorkflowOpenedCornerView) => void;
  testID: string;
}) {
  const visit = step.visits[0];
  const meta = workflowStepMeta(step, {
    contract: detail.contract,
    run: detail.run,
    history: detail.history,
  });
  const assignee = workflowStepAssignee(step, detail);
  const isViewer = assignee !== undefined && assignee.id === detail.viewer?.id;
  const current = step.status === 'current';
  const draft = current && assignee?.kind === 'agent'
    ? Array.from(liveDrafts ?? []).reverse().find(([turn]) => visit?.outputTurns?.includes(turn))?.[1]
      ?? visit?.liveOutput
    : undefined;
  // A gate's own resolution line already states the result (the pick and who
  // picked it); showing the agent's final message too would say it twice.
  const final = !current && step.kind === 'handoff' ? visit?.finalReply : undefined;
  const does = detail.contract.handoffs[step.state]?.does;
  const gate = visit?.gate;
  const gateWaitingOn = detail.run.viewerHolds ? 'you' : `a person in ${detail.run.roomName}`;
  const gateLine =
    step.kind === 'gate'
      ? gate?.answer !== undefined
        ? `${gate.answer}${gate.answeredBy ? ` · ${gate.answeredBy.name}` : ''}`
        : current
          ? `Waiting on ${gateWaitingOn}`
          : undefined
      : undefined;
  const name = workflowStateLabel(step.state);
  const label = [name, does, STATUS_WORD[step.status], assignee?.name, meta].filter(Boolean).join(', ');
  const seconds = stepSeconds(step, now);
  // The terminal that ends the run reads by the clock it was reached, not an elapsed span.
  const reachedAt = step.kind === 'terminal' ? visit?.enteredAt : undefined;
  const dimmed = step.status === 'pending' ? styles.dimmed : null;
  // Every step starts open; a tap collapses it to its one-line description,
  // and a second tap reopens it.
  const hasDetail = Boolean(draft || final || gateLine || visit?.openedCorners?.length);
  const [expanded, setExpanded] = useState(true);
  const open = expanded || !hasDetail;
  return (
    <View style={styles.step} testID={testID}>
      {above ? <Segment style={styles.lineAbove} testID={`${testID}-above`} tone={above} vertical /> : null}
      {below ? <Segment style={styles.lineBelow} testID={`${testID}-below`} tone={below} vertical /> : null}
      <Pressable
        accessibilityHint={hasDetail ? (expanded ? 'Hides this step’s output' : 'Shows this step’s output') : undefined}
        accessibilityLabel={label}
        accessibilityRole={hasDetail ? 'button' : undefined}
        accessibilityState={hasDetail ? { expanded } : undefined}
        aria-expanded={hasDetail ? expanded : undefined}
        onPress={hasDetail ? () => setExpanded((value) => !value) : undefined}
        style={({ pressed }) => [styles.summary, pressed && hasDetail && styles.pressed]}
        testID={`${testID}-header`}
      >
        {current ? (
          <HullLivePulse style={styles.halo}>
            <View style={styles.haloRing} testID={`${testID}-halo`} />
          </HullLivePulse>
        ) : null}
        <View style={styles.circle}>
          <WorkflowStepCircle status={step.status} testID={`${testID}-circle-${step.status}`} />
        </View>
        <View style={[styles.copy, dimmed]}>
          <Text style={current ? styles.nameCurrent : styles.name}>
            {name}
            {meta ? <Text style={styles.meta}>{` · ${meta}`}</Text> : null}
          </Text>
        </View>
        <View style={[styles.right, dimmed]}>
          {assignee ? <Assignee actor={assignee} testID={testID} viewer={isViewer} /> : null}
          {reachedAt !== undefined ? (
            <Text style={styles.duration} testID={`${testID}-duration`}>{CLOCK.format(new Date(reachedAt * 1_000))}</Text>
          ) : seconds !== undefined ? (
            <Text style={styles.duration} testID={`${testID}-duration`}>{formatRunDuration(seconds)}</Text>
          ) : null}
        </View>
      </Pressable>
      <View style={[styles.outcome, dimmed]}>
        {does ? <Text style={styles.does} testID={`${testID}-description`}>{does}</Text> : null}
        {open && draft ? (
          <Text
            ellipsizeMode="head"
            numberOfLines={2}
            style={[provisionalProseStyle(), styles.live]}
            testID={`${testID}-live`}
          >
            {draft.replace(/\s+/g, ' ').trim()}
          </Text>
        ) : null}
        {open && final ? (
          <Text style={[settledAgentProseStyle(), styles.final]} testID={`${testID}-final`}>{final.text}</Text>
        ) : null}
        {open && gateLine ? <Text style={styles.gateLine} testID={`${testID}-gate`}>{gateLine}</Text> : null}
        {open && visit?.openedCorners?.length ? (
          <OpenedCorners corners={visit.openedCorners} onOpenCorner={onOpenCorner} testID={testID} />
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => {
  const { type, space } = theme.buzz;
  return {
    brass: { color: theme.buzz.accent },
    quietLine: { color: theme.buzz.borderStrong },
    ground: { color: theme.buzz.bgBase },
    hollow: { color: theme.buzz.textMuted },
    quiet: { color: theme.buzz.ledgerQuiet },
    ink: { color: theme.buzz.textSecondary },
    // The current step's halo (HALO, wider than the circle it rings) would
    // otherwise touch whatever sits directly above the rail — the page's
    // section divider when the run's first step is the one running. The
    // same space.sm rhythm the row's own text uses keeps it clear.
    list: { paddingTop: space.sm },
    step: { position: 'relative' },
    lineAbove: { position: 'absolute', left: LINE_X - 1, width: 2, top: 0, height: CIRCLE_TOP },
    lineBelow: {
      position: 'absolute',
      left: LINE_X - 1,
      width: 2,
      top: CIRCLE_TOP + CIRCLE,
      bottom: 0,
    },
    outcome: { marginLeft: COPY_X, marginRight: space.md, paddingBottom: space.sm },
    summary: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      paddingLeft: COPY_X,
      paddingRight: space.md,
    },
    pressed: { backgroundColor: theme.buzz.bgPressed },
    circle: { position: 'absolute', left: LINE_X - CIRCLE / 2, top: CIRCLE_TOP },
    halo: {
      position: 'absolute',
      left: LINE_X - HALO / 2,
      top: CIRCLE_TOP + CIRCLE / 2 - HALO / 2,
      width: HALO,
      height: HALO,
    },
    haloRing: {
      width: HALO,
      height: HALO,
      borderRadius: HALO / 2,
      borderWidth: 1,
      borderColor: theme.buzz.accent,
    },
    copy: { flex: 1, minWidth: 0, paddingTop: space.sm, paddingBottom: space.sm },
    name: { ...type.body, color: theme.buzz.textPrimary },
    nameCurrent: { ...type.bodyStrong, color: theme.buzz.textPrimary },
    meta: { ...type.meta, color: theme.buzz.ledgerQuiet },
    right: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingTop: CIRCLE_TOP },
    assignee: { flexDirection: 'row', alignItems: 'center', gap: space.sm, maxWidth: 140 },
    handle: { ...type.meta, flexShrink: 1 },
    does: { ...type.meta, color: theme.buzz.textSecondary, marginTop: 4 },
    dimmed: { opacity: 0.45 },
    // Colour and face come from the shared provisional/settled prose styles
    // (components/buzz/Ledger.tsx) — the same tones a live draft and a
    // finished agent reply already read in, elsewhere in the app — but sized
    // down to `type.meta` (applied after, so it wins): a step's one-line
    // description sets the scale here, not the Room's full message size.
    // Transient while it's still being written: italic, on top of the shared
    // provisional tone — visibly distinct from a final reply's settled style.
    live: { ...type.meta, marginTop: space.xs, fontStyle: 'italic' },
    final: { ...type.meta, marginTop: space.xs },
    gateLine: { ...type.meta, color: theme.buzz.textSecondary, marginTop: space.xs },
    duration: { ...type.machine, color: theme.buzz.ledgerGhost },
    corners: { marginTop: space.sm },
    cornerLink: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: space.sm },
    cornerName: { ...type.meta, flex: 1, minWidth: 0, color: theme.buzz.textPrimary },
    cornerArrow: { ...type.meta, color: theme.buzz.accent },
  };
});
