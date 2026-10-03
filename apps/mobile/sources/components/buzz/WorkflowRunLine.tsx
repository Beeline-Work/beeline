import React, { useMemo, useState } from 'react';
import { Linking, Pressable, Text, View } from 'react-native';
import Svg, { Circle, Line, Path } from 'react-native-svg';
import { StyleSheet } from 'react-native-unistyles';
import type {
  WorkflowActorView,
  WorkflowContract,
  WorkflowOpenedCornerView,
  WorkflowRunDetailView,
  WorkflowReceiptInput,
} from '@beeline/api-contract/phone';
import {
  workflowRunLine,
  workflowStateLabel,
  type WorkflowLineStatus,
  type WorkflowLineStep,
  type WorkflowLineVisit,
} from '@/buzz/workflow-graph';
import {
  deliveredFields,
  formatRunDuration,
  outcomeLabel,
  stepSeconds,
  visitSeconds,
  workflowStepAssignee,
  workflowStepMeta,
} from '@/buzz/workflow-run-copy';
import { identityPalette, isGeneratedAgentAvatarUrl } from '@/buzz/identity-mark';
import { previewHandle } from '@/buzz/room-list-row';
import { CORNER_META_SIZE, CornerGlyph } from './CornerGlyph';
import { DECORATIVE_GLYPH_PROPS } from './decorative-glyph';
import { IdentityMark } from './IdentityMark';
import { HullLivePulse } from './MonoHull';

const CIRCLE = 20;
const HALO = 32;
/** The circle's top within a step row, and the line's x (the circle's centre). */
const CIRCLE_TOP = 8;
const LINE_X = 28;
/** Where a step's copy column starts, right of the rail and its halo. */
const COPY_X = 56;
/** The readout's line-number column; item lists hang under the key, past it. */
const LINE_INDEX_WIDTH = 24;
/** The assignee's mark: the step circle's size, so the row keeps one height. */
const ASSIGNEE_MARK = CIRCLE;

const CLOCK = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});
const clock = (at: number) => CLOCK.format(new Date(at * 1_000));

/** The status in words, for a screen reader: the circle's shape and tone say it to the eye. */
const STATUS_WORD: Record<WorkflowLineStatus, string> = {
  done: 'done',
  current: 'current step',
  pending: 'not yet reached',
  skipped: 'skipped',
  failed: 'failed',
};

const reached = (step: WorkflowLineStep) =>
  step.status === 'done' || step.status === 'current' || step.status === 'failed';

type SegmentTone = 'brass' | 'quiet' | 'dashed';

/** Brass where the run went, dashed past a skipped step, quiet ahead. */
function segmentTone(above: WorkflowLineStep, below: WorkflowLineStep): SegmentTone {
  if (above.status === 'skipped' || below.status === 'skipped') return 'dashed';
  return reached(above) && reached(below) ? 'brass' : 'quiet';
}

/** One step's circle: brass check, breathing brass ring, hollow, ghost slash, or ink x. */
export function WorkflowStepCircle({
  status,
  size = CIRCLE,
  testID,
}: {
  status: WorkflowLineStatus;
  size?: number;
  testID?: string;
}) {
  const { brass, ground, hollow, ghost, ink } = palette();
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
      ) : status === 'skipped' ? (
        <>
          <Circle
            cx={10}
            cy={10}
            fill={ground}
            r={8}
            stroke={ghost}
            strokeDasharray="2.5 2.2"
            strokeWidth={1.5}
          />
          <Path d="M6.5 13.5l7-7" stroke={ghost} strokeLinecap="round" strokeWidth={1.5} />
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
    ghost: styles.ghost.color,
    ink: styles.ink.color,
  };
}

/** A 2pt piece of the line: solid brass or quiet, or a dashed ghost past a skip. */
function Segment({
  tone,
  vertical,
  style,
  testID,
}: {
  tone: SegmentTone;
  vertical: boolean;
  style: object;
  testID?: string;
}) {
  const { brass, quiet, ghost } = palette();
  if (tone !== 'dashed')
    return (
      <View
        style={[style, { backgroundColor: tone === 'brass' ? brass : quiet }]}
        testID={testID ? `${testID}-${tone}` : undefined}
      />
    );
  return (
    <View style={style} testID={testID ? `${testID}-dashed` : undefined}>
      <Svg {...DECORATIVE_GLYPH_PROPS} height="100%" width="100%">
        <Line
          stroke={ghost}
          strokeDasharray="3 4"
          strokeWidth={2}
          x1={vertical ? 1 : 0}
          x2={vertical ? 1 : '100%'}
          y1={vertical ? 0 : 1}
          y2={vertical ? '100%' : 1}
        />
      </Svg>
    </View>
  );
}

/**
 * One state rail, with receipts and transition exits inside each state.
 * Tapping a state expands its recorded visits. The page reads the run;
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
  /** Each working agent's streaming reply in the run's Room, by agent id. */
  liveDrafts?: ReadonlyMap<string, string>;
  onOpenCorner: (corner: WorkflowOpenedCornerView) => void;
  testID?: string;
}) {
  const line = useMemo(
    () => workflowRunLine(detail.contract, detail.history),
    [detail.contract, detail.history],
  );
  const [open, setOpen] = useState<ReadonlySet<string>>(
    () => new Set(line.filter((step) => step.status === 'current').map((step) => step.state)),
  );
  const toggle = (state: string) =>
    setOpen((previous) => {
      const next = new Set(previous);
      if (next.has(state)) next.delete(state);
      else next.add(state);
      return next;
    });
  return (
    <View testID={testID}>
      {line.map((step, index) => (
        <StepRow
          above={index > 0 ? segmentTone(line[index - 1]!, step) : undefined}
          below={index < line.length - 1 ? segmentTone(step, line[index + 1]!) : undefined}
          detail={detail}
          expanded={open.has(step.state)}
          key={step.state}
          liveDrafts={liveDrafts}
          now={now}
          onOpenCorner={onOpenCorner}
          onToggle={() => toggle(step.state)}
          step={step}
          testID={`${testID}-step-${step.state}`}
        />
      ))}
    </View>
  );
}

/** Skipped steps and terminals carry nothing more than their row says. */
function expandable(step: WorkflowLineStep): boolean {
  return step.status !== 'skipped' && step.kind !== 'terminal';
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

function StepRow({
  step,
  detail,
  now,
  liveDrafts,
  above,
  below,
  expanded,
  onToggle,
  onOpenCorner,
  testID,
}: {
  step: WorkflowLineStep;
  detail: WorkflowRunDetailView;
  now: number;
  liveDrafts?: ReadonlyMap<string, string>;
  above?: SegmentTone;
  below?: SegmentTone;
  expanded: boolean;
  onToggle: () => void;
  onOpenCorner: (corner: WorkflowOpenedCornerView) => void;
  testID: string;
}) {
  const latest = step.visits[step.visits.length - 1];
  const meta = workflowStepMeta(step, {
    contract: detail.contract,
    run: detail.run,
    history: detail.history,
  });
  const assignee = workflowStepAssignee(step, detail);
  const isViewer = assignee !== undefined && assignee.id === detail.viewer?.id;
  const draft =
    step.status === 'current' && assignee?.kind === 'agent' ? liveDrafts?.get(assignee.id) : undefined;
  const name = workflowStateLabel(step.state);
  const label = [name, STATUS_WORD[step.status], assignee?.name, meta].filter(Boolean).join(', ');
  const seconds = step.kind === 'terminal' ? undefined : stepSeconds(step, now);
  const reachedAt = step.kind === 'terminal' ? step.visits[0]?.enteredAt : undefined;
  const canOpen = expandable(step);
  const current = step.status === 'current';
  const muted = step.status === 'skipped' ? styles.ghost : step.status === 'pending' ? styles.quiet : null;
  const summary = (
    <>
      {current ? (
        <HullLivePulse style={styles.halo}>
          <View style={styles.haloRing} testID={`${testID}-halo`} />
        </HullLivePulse>
      ) : null}
      <View style={styles.circle}>
        <WorkflowStepCircle status={step.status} testID={`${testID}-circle-${step.status}`} />
      </View>
      <View style={styles.copy}>
        <Text style={[current ? styles.nameCurrent : styles.name, muted]}>
          {name}
          {step.visits.length > 1 ? <Text style={styles.times}>{`  ×${step.visits.length}`}</Text> : null}
          {meta ? <Text style={styles.meta}>{` · ${meta}`}</Text> : null}
        </Text>
      </View>
      <View style={styles.right}>
        {assignee ? <Assignee actor={assignee} testID={testID} viewer={isViewer} /> : null}
        {seconds !== undefined ? (
          <Text style={styles.duration}>{formatRunDuration(seconds)}</Text>
        ) : reachedAt !== undefined ? (
          <Text style={styles.duration}>{clock(reachedAt)}</Text>
        ) : null}
        {canOpen ? <Chevron open={expanded} /> : null}
      </View>
    </>
  );
  return (
    <View style={styles.step} testID={testID}>
      {above ? <Segment style={styles.lineAbove} testID={`${testID}-above`} tone={above} vertical /> : null}
      {below ? <Segment style={styles.lineBelow} testID={`${testID}-below`} tone={below} vertical /> : null}
      {canOpen ? (
        <Pressable
          accessibilityLabel={label}
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          onPress={onToggle}
          style={({ pressed }) => [styles.summary, pressed && styles.pressed]}
          testID={`${testID}-toggle`}
        >
          {summary}
        </Pressable>
      ) : (
        <View
          accessibilityLabel={label}
          accessible
          style={styles.summary}
        >
          {summary}
        </View>
      )}
      <View style={styles.outcome}>
        {draft ? (
          <Text
            ellipsizeMode="head"
            numberOfLines={2}
            style={styles.live}
            testID={`${testID}-live`}
          >
            {draft.replace(/\s+/g, ' ').trim()}
          </Text>
        ) : null}
        <Receipt receipt={latest?.receipt} testID={testID} />
        {current ? (
          <Text style={styles.exits} testID={`${testID}-exits`}>
            {stateExits(step, detail.contract)}
          </Text>
        ) : latest?.outcome && latest.nextState ? (
          <Text style={styles.exits} testID={`${testID}-exit`}>
            {`→ ${workflowStateLabel(latest.nextState)} via ${latest.receipt?.exit.gate ?? latest.outcome}`}
          </Text>
        ) : null}
      </View>
      {canOpen && expanded ? (
        <View style={styles.readout} testID={`${testID}-readout`}>
          <StepReadout
            detail={detail}
            now={now}
            onOpenCorner={onOpenCorner}
            step={step}
            testID={testID}
          />
        </View>
      ) : null}
    </View>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <Svg
      {...DECORATIVE_GLYPH_PROPS}
      height={12}
      style={open ? styles.chevronOpen : undefined}
      viewBox="0 0 12 12"
      width={12}
    >
      <Path
        d="M4.5 2.5L8 6l-3.5 3.5"
        fill="none"
        stroke={styles.ghost.color}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
      />
    </Svg>
  );
}

type ReadoutLine = { key: string; value: React.ReactNode; items?: readonly string[] };

function stateExits(step: WorkflowLineStep, contract: WorkflowContract): string {
  const state = contract.handoffs[step.state];
  if (!state || !('on' in state)) return '';
  return `Exits: ${Object.entries(state.on).map(([gate, target]) =>
    `${gate} → ${workflowStateLabel(target)}`).join(' · ')}`;
}

/** Every workflow uses the same optional outcome line and typed reference chips. */
function Receipt({ receipt, testID }: { receipt?: WorkflowReceiptInput; testID: string }) {
  const [error, setError] = useState(false);
  if (!receipt?.line && !receipt?.refs?.length) return null;
  return (
    <View testID={`${testID}-receipt`}>
      {receipt.line ? <Text style={styles.receiptLine}>{receipt.line}</Text> : null}
      {receipt.refs?.length ? (
        <View style={styles.refs}>
          {receipt.refs.map((ref, index) => (
            <Pressable
              accessibilityLabel={`${ref.kind}: ${ref.label}`}
              accessibilityRole="link"
              key={`${ref.kind}:${index}`}
              onPress={() => {
                setError(false);
                void Linking.openURL(ref.url).catch(() => setError(true));
              }}
              style={({ pressed }) => [styles.ref, pressed && styles.pressed]}
              testID={`${testID}-ref-${ref.kind}-${index}`}
            >
              <Text style={styles.refText}>{`${ref.kind} · ${ref.label}`}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      {error ? <Text accessibilityRole="alert" style={styles.meta}>Could not open this reference. Tap to retry.</Text> : null}
    </View>
  );
}

/** Numbered machine lines on a quiet 2pt rule, the way a run log reads. */
function Readout({ lines, testID }: { lines: readonly ReadoutLine[]; testID?: string }) {
  return (
    <View style={styles.rule} testID={testID}>
      {lines.map((line, index) => (
        <View key={`${line.key}:${index}`}>
          <View style={styles.line}>
            <Text style={styles.lineIndex}>{index + 1}</Text>
            <Text style={styles.lineKey}>{line.key}</Text>
            <Text style={styles.lineValue}>{line.value}</Text>
          </View>
          {line.items?.length ? (
            <View style={styles.items}>
              {line.items.map((item, itemIndex) => (
                <View key={itemIndex} style={styles.item}>
                  <Text style={styles.itemIndex}>{itemIndex + 1}</Text>
                  <Text style={styles.itemText}>{item}</Text>
                </View>
              ))}
            </View>
          ) : null}
        </View>
      ))}
    </View>
  );
}

const Brass = ({ children }: { children: React.ReactNode }) => (
  <Text style={styles.brass}>{children}</Text>
);
const Ghost = ({ children }: { children: React.ReactNode }) => (
  <Text style={styles.ghost}>{children}</Text>
);

/** The outcomes a step can still leave by: `then approved → Land`, `or changes → Implement · 0 of 3`. */
function outcomeLines(step: WorkflowLineStep, contract: WorkflowContract): ReadoutLine[] {
  const declared = contract.handoffs[step.state];
  if (!declared || declared.kind === 'terminal' || declared.kind === 'waiting') return [];
  const loop = 'loop' in declared ? declared.loop : undefined;
  return Object.entries(declared.on).map(([outcome, target], index) => ({
    key: index === 0 ? 'then' : 'or',
    value: (
      <>
        <Brass>{outcome}</Brass> → {workflowStateLabel(target)}
        {loop && loop.onEdge === outcome ? (
          <Ghost>{` · ${step.loop?.taken ?? 0} of ${loop.cap}`}</Ghost>
        ) : null}
      </>
    ),
  }));
}

/** The gate's card as it was settled: question, options, and who chose what when. */
function gateLines(
  visit: WorkflowLineVisit,
  detail: WorkflowRunDetailView,
  open: boolean,
): ReadoutLine[] {
  const gate = visit.gate;
  const waitingOn = detail.run.viewerHolds ? 'you' : `a person in ${detail.run.roomName}`;
  if (!gate)
    return visit.outcome !== undefined
      ? [{ key: 'answer', value: <Brass>{visit.outcome}</Brass> }]
      : open
        ? [{ key: 'answer', value: <Ghost>{`waiting on ${waitingOn}`}</Ghost> }]
        : [];
  const lines: ReadoutLine[] = [
    { key: 'asked', value: gate.question },
    ...(open ? gate.options : []).map((option) => ({
      key: `option ${option.letter}`,
      value: (
        <>
          {option.label}
          <Ghost>{` · ${option.consequence}`}</Ghost>
        </>
      ),
    })),
  ];
  if (gate.answer !== undefined) {
    lines.push({
      key: 'answer',
      value: (
        <>
          <Brass>{gate.answer}</Brass>
          {gate.answeredBy ? ` · ${gate.answeredBy.name}` : ''}
          {gate.answeredAt !== undefined ? ` · ${clock(gate.answeredAt)}` : ''}
        </>
      ),
    });
    if (gate.note) lines.push({ key: 'note', value: gate.note });
  } else if (gate.status === 'open')
    lines.push({ key: 'answer', value: <Ghost>{`waiting on ${waitingOn}`}</Ghost> });
  else lines.push({ key: 'answer', value: <Ghost>{gate.status}</Ghost> });
  return lines;
}

function deliveredLines(visit: WorkflowLineVisit): ReadoutLine[] {
  if (!visit.delivered) return [];
  return deliveredFields(visit.delivered).map((field) => ({
    key: 'delivered',
    value: (
      <>
        {field.field}
        {field.count !== undefined ? <Ghost>{` · ${field.count || 'none'}`}</Ghost> : null}
      </>
    ),
    items: field.items,
  }));
}

/** One visit's lines: when it was entered and left, how, and what it handed off. */
function visitLines(
  step: WorkflowLineStep,
  visit: WorkflowLineVisit,
  detail: WorkflowRunDetailView,
): ReadoutLine[] {
  const open = visit.leftAt === undefined && step.status === 'current';
  return [
    { key: 'entered', value: clock(visit.enteredAt) },
    ...(visit.leftAt !== undefined
      ? [
          {
            key: 'left',
            value: (
              <>
                {clock(visit.leftAt)}
                {visit.outcome !== undefined ? (
                  <>
                    {' · '}
                    <Brass>{visit.outcome}</Brass>
                  </>
                ) : null}
                {visit.nextState ? ` → ${workflowStateLabel(visit.nextState)}` : ''}
              </>
            ),
          },
        ]
      : []),
    ...(step.kind === 'gate' ? gateLines(visit, detail, open) : []),
    ...deliveredLines(visit),
  ];
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
      <Text style={styles.cornersHead}>Opened</Text>
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

function VisitBody({
  step,
  visit,
  detail,
  onOpenCorner,
  testID,
}: {
  step: WorkflowLineStep;
  visit: WorkflowLineVisit;
  detail: WorkflowRunDetailView;
  onOpenCorner: (corner: WorkflowOpenedCornerView) => void;
  testID: string;
}) {
  return (
    <>
      <Readout lines={visitLines(step, visit, detail)} />
      {step.visits.length > 1 ? <Receipt receipt={visit.receipt} testID={testID} /> : null}
      {visit.openedCorners?.length ? (
        <OpenedCorners corners={visit.openedCorners} onOpenCorner={onOpenCorner} testID={testID} />
      ) : null}
    </>
  );
}

function StepReadout({
  step,
  detail,
  now,
  onOpenCorner,
  testID,
}: {
  step: WorkflowLineStep;
  detail: WorkflowRunDetailView;
  now: number;
  onOpenCorner: (corner: WorkflowOpenedCornerView) => void;
  testID: string;
}) {
  if (step.visits.length === 0) {
    const declared = detail.contract.handoffs[step.state];
    const requires = declared && 'requires' in declared ? declared.requires : [];
    return (
      <Readout
        lines={[
          {
            key: 'delivers',
            value: requires.length > 0 ? requires.join(', ') : <Ghost>nothing</Ghost>,
          },
          ...outcomeLines(step, detail.contract),
        ]}
      />
    );
  }
  if (step.visits.length === 1)
    return (
      <VisitBody
        detail={detail}
        onOpenCorner={onOpenCorner}
        step={step}
        testID={testID}
        visit={step.visits[0]!}
      />
    );
  return <Attempts detail={detail} now={now} onOpenCorner={onOpenCorner} step={step} testID={testID} />;
}

/** A step the run entered more than once: each attempt, newest first, opens like a step. */
function Attempts({
  step,
  detail,
  now,
  onOpenCorner,
  testID,
}: {
  step: WorkflowLineStep;
  detail: WorkflowRunDetailView;
  now: number;
  onOpenCorner: (corner: WorkflowOpenedCornerView) => void;
  testID: string;
}) {
  const count = step.visits.length;
  const [open, setOpen] = useState<number | null>(count);
  const attempts = step.visits.map((visit, index) => ({ visit, number: index + 1 })).reverse();
  return (
    <View>
      {attempts.map(({ visit, number }) => {
        const live = visit.leftAt === undefined && step.status === 'current';
        const expanded = open === number;
        return (
          <View key={number} testID={`${testID}-attempt-${number}`}>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded }}
              onPress={() => setOpen(expanded ? null : number)}
              style={({ pressed }) => [styles.attempt, pressed && styles.pressed]}
              testID={`${testID}-attempt-${number}-toggle`}
            >
              <Text numberOfLines={1} style={styles.attemptText}>
                {`Attempt ${number}`}
                <Text style={styles.quiet}>
                  {visit.outcome !== undefined
                    ? ` · ${outcomeLabel(visit.outcome)}${visit.nextState ? ` → ${workflowStateLabel(visit.nextState)}` : ''}`
                    : live
                      ? ' · now'
                      : ''}
                </Text>
              </Text>
              <Text style={styles.duration}>{formatRunDuration(visitSeconds(visit, now))}</Text>
              <Chevron open={expanded} />
            </Pressable>
            {expanded ? (
              <View style={styles.attemptBody}>
                <VisitBody
                  detail={detail}
                  onOpenCorner={onOpenCorner}
                  step={step}
                  testID={`${testID}-attempt-${number}`}
                  visit={visit}
                />
              </View>
            ) : null}
          </View>
        );
      })}
      {step.loop ? (
        <Readout
          lines={[
            {
              key: 'loop',
              value: `${step.loop.taken} of ${step.loop.cap} rounds used`,
            },
          ]}
          testID={`${testID}-loop`}
        />
      ) : null}
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
    ghost: { color: theme.buzz.ledgerGhost },
    quiet: { color: theme.buzz.ledgerQuiet },
    ink: { color: theme.buzz.textSecondary },
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
    receiptLine: { ...type.body, color: theme.buzz.textSecondary, marginBottom: space.xs },
    refs: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
    ref: { minHeight: 44, justifyContent: 'center', paddingHorizontal: space.sm,
      borderRadius: theme.buzz.radius, backgroundColor: theme.buzz.bgPressed },
    refText: { ...type.meta, color: theme.buzz.accent },
    exits: { ...type.meta, color: theme.buzz.textSecondary, marginTop: space.xs },
    summary: {
      minHeight: theme.buzz.layout.row,
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
    times: { ...type.machine, color: theme.buzz.accent },
    meta: { ...type.meta, color: theme.buzz.ledgerQuiet },
    right: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingTop: CIRCLE_TOP },
    assignee: { flexDirection: 'row', alignItems: 'center', gap: space.sm, maxWidth: 140 },
    handle: { ...type.meta, flexShrink: 1 },
    live: { ...type.meta, color: theme.buzz.ledgerQuiet, marginBottom: space.xs },
    duration: { ...type.machine, color: theme.buzz.ledgerGhost },
    chevronOpen: { transform: [{ rotate: '90deg' }] },
    readout: { marginLeft: COPY_X, marginRight: space.md, paddingTop: space.xs, paddingBottom: space.md },
    rule: {
      borderLeftWidth: 2,
      borderLeftColor: theme.buzz.borderStrong,
      paddingLeft: space.md,
      paddingVertical: space.xs,
    },
    line: { flexDirection: 'row' },
    lineIndex: { ...type.machine, width: LINE_INDEX_WIDTH, color: theme.buzz.ledgerGhost },
    lineKey: { ...type.machine, width: 76, color: theme.buzz.ledgerQuiet },
    lineValue: { ...type.machine, flex: 1, minWidth: 0, color: theme.buzz.textSecondary },
    items: { marginLeft: LINE_INDEX_WIDTH, marginTop: space.xs, marginBottom: space.xs },
    item: { flexDirection: 'row', gap: space.sm, paddingVertical: space.xs },
    itemIndex: { ...type.machine, width: 12, color: theme.buzz.ledgerGhost },
    itemText: { ...type.meta, flex: 1, minWidth: 0, color: theme.buzz.textSecondary },
    corners: { marginTop: space.sm },
    cornersHead: { ...type.sectionHead, color: theme.buzz.ledgerQuiet, marginBottom: space.xs },
    cornerLink: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: space.sm },
    cornerName: { ...type.meta, flex: 1, minWidth: 0, color: theme.buzz.textPrimary },
    cornerArrow: { ...type.meta, color: theme.buzz.accent },
    attempt: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: space.sm },
    attemptText: { ...type.meta, flex: 1, minWidth: 0, color: theme.buzz.textSecondary },
    attemptBody: { marginLeft: space.lg, marginBottom: space.sm },
  };
});
