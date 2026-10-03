import type { Href } from 'expo-router';
import type {
  WorkflowActorView,
  WorkflowContract,
  WorkflowRunSummaryView,
} from '@beeline/api-contract/phone';
import { SYSTEM_IDENTITY_PUBKEY } from './system-identity';
import {
  workflowStateLabel,
  type WorkflowLineStep,
  type WorkflowLineVisit,
} from './workflow-graph';

/** The run page for one workflow run. */
export function workflowRunHref(run: Pick<WorkflowRunSummaryView, 'roomId' | 'runId'>): Href {
  return {
    pathname: '/beeline/workflow-run',
    params: { roomId: run.roomId, runId: run.runId },
  } as unknown as Href;
}

const TERMINAL_LABEL = { done: 'Done', failed: 'Failed', abandoned: 'Abandoned' } as const;

/** `round 2 of 3`: the current trip out of the loop's cap. Hidden until the run has taken the loop edge once. */
export function loopRoundLabel(loop: WorkflowLineStep['loop']): string | undefined {
  if (!loop || loop.taken < 1) return undefined;
  return `round ${Math.min(loop.taken + 1, loop.cap)} of ${loop.cap}`;
}

/** `nothing_new` → `nothing new`. */
export function outcomeLabel(outcome: string): string {
  return workflowStateLabel(outcome).toLowerCase();
}

function capitalized(line: string): string {
  return line ? `${line[0]!.toUpperCase()}${line.slice(1)}` : line;
}

/** The role a state names, if any. */
export function stateRole(contract: WorkflowContract, state: string): string | undefined {
  const declared = contract.handoffs[state];
  if (!declared || declared.kind === 'terminal') return undefined;
  return declared.role;
}

/**
 * Who holds or held a step, drawn at the row's right: the run's holder for the
 * current step (the viewer when it waits on them), whoever left a reached step
 * (the person who answered a gate), and the identity bound to a pending step's
 * role. A step with no role (the server runs it, or it waits) and a skipped
 * step have none.
 */
export function workflowStepAssignee(
  step: WorkflowLineStep,
  input: {
    contract: WorkflowContract;
    roleHolders: Readonly<Record<string, WorkflowActorView>>;
    run: Pick<WorkflowRunSummaryView, 'viewerHolds' | 'holder'>;
    viewer?: WorkflowActorView;
  },
): WorkflowActorView | undefined {
  const role = stateRole(input.contract, step.state);
  if (!role || step.status === 'skipped') return undefined;
  const bound = input.roleHolders[role];
  if (step.status === 'current')
    return (input.run.viewerHolds ? input.viewer : undefined) ?? input.run.holder ?? bound;
  if (step.status === 'pending') return bound;
  const exit = step.visits[step.visits.length - 1];
  // Corner lifecycle cards are written by the system identity, which holds no step.
  const leftBy = exit?.leftBy?.id === SYSTEM_IDENTITY_PUBKEY ? undefined : exit?.leftBy;
  return (step.kind === 'gate' ? exit?.gate?.answeredBy : undefined) ?? leftBy ?? bound;
}

/** The last visit's entry point: the state it came from. */
function enteredFrom(step: WorkflowLineStep, history: readonly { fromState?: string; toState: string }[]) {
  for (let index = history.length - 1; index >= 0; index -= 1)
    if (history[index]!.toState === step.state) return history[index]!.fromState;
  return undefined;
}

/**
 * A step's one meta line beside its name: whose move it is now, that the
 * server runs it, or why it was skipped. Who holds a step is its mark
 * (`workflowStepAssignee`), so no name is repeated here.
 */
export function workflowStepMeta(
  step: WorkflowLineStep,
  input: {
    contract: WorkflowContract;
    run: Pick<WorkflowRunSummaryView, 'viewerHolds'>;
    history: readonly { fromState?: string; toState: string }[];
  },
): string {
  const roleless = !stateRole(input.contract, step.state);
  const automatic = !roleless
    ? undefined
    : step.kind === 'server' ? 'Automatic' : step.kind === 'waiting' ? 'Waiting' : undefined;
  const round = loopRoundLabel(step.loop);
  if (step.status === 'skipped') {
    const by = step.skippedBy;
    if (!by) return 'Skipped';
    if (by.outcome === undefined) return `Skipped · run ended at ${workflowStateLabel(by.state)}`;
    return `Skipped · ${workflowStateLabel(by.state)}: ${outcomeLabel(by.outcome)}`;
  }
  if (step.kind === 'terminal') {
    if (step.status === 'pending') return 'Ends the run';
    const from = enteredFrom(step, input.history);
    const ended = from ? `ended by ${workflowStateLabel(from)}` : 'ended';
    return step.terminalStatus === 'done' || !step.terminalStatus
      ? capitalized(ended)
      : `${TERMINAL_LABEL[step.terminalStatus]} · ${ended}`;
  }
  // A reached step's outcome is on its exit line below the row.
  const parts =
    step.status === 'current' && input.run.viewerHolds
      ? [step.kind === 'gate' ? 'Your call' : 'Waiting on you', step.kind === 'gate' ? 'gate' : undefined, round]
      : [automatic, step.status === 'current' ? round : undefined];
  return capitalized(parts.filter((part): part is string => Boolean(part)).join(' · '));
}

/** `9s`, `2m 05s`, `48m`, `1h 12m`. */
export function formatRunDuration(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  if (whole < 60) return `${whole}s`;
  if (whole < 600) return `${Math.floor(whole / 60)}m ${String(whole % 60).padStart(2, '0')}s`;
  if (whole < 3600) return `${Math.floor(whole / 60)}m`;
  return `${Math.floor(whole / 3600)}h ${Math.floor((whole % 3600) / 60)}m`;
}

/** How long a visit lasted; a visit still open runs to `now`. */
export function visitSeconds(visit: WorkflowLineVisit, now: number): number {
  return (visit.leftAt ?? now) - visit.enteredAt;
}

/** The time a step took, summed over its visits. Undefined for a step the run never entered. */
export function stepSeconds(step: WorkflowLineStep, now: number): number | undefined {
  if (step.visits.length === 0) return undefined;
  return step.visits.reduce((total, visit) => total + visitSeconds(visit, now), 0);
}

/**
 * The run's status line, as GitHub Actions heads a run: whose move it is, the
 * step it is in, or how it ended.
 */
export function workflowRunHeadline(
  run: Pick<WorkflowRunSummaryView, 'status' | 'viewerHolds' | 'state'>,
  lastOutcome?: string,
): string {
  if (run.status === 'live')
    return run.viewerHolds ? 'Waiting on you' : `In ${workflowStateLabel(run.state).toLowerCase()}`;
  const status = TERMINAL_LABEL[run.status];
  return lastOutcome !== undefined ? `${status} · ${outcomeLabel(lastOutcome)}` : status;
}

const DAY = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });

/** `Today`, `Yesterday`, or the date a run started. */
export function runDayLabel(startedAt: number, now = Date.now()): string {
  const started = new Date(startedAt * 1_000);
  const today = new Date(now);
  const midnight = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  if (started.getTime() >= midnight) return 'Today';
  if (started.getTime() >= midnight - 86_400_000) return 'Yesterday';
  return DAY.format(started);
}

/** One field of what a step handed off: `problems · 3` and its items, one line each. */
export type DeliveredField = { readonly field: string; readonly count?: number; readonly items: string[] };

const ITEM_TEXT_KEYS = ['title', 'description', 'summary', 'name', 'label', 'text'] as const;

function itemText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const key = ITEM_TEXT_KEYS.find((name) => typeof record[name] === 'string');
    if (key) return record[key] as string;
  }
  return JSON.stringify(value) ?? '';
}

/** A handoff's contents as the readout lists them. */
export function deliveredFields(contents: Readonly<Record<string, unknown>>): DeliveredField[] {
  return Object.entries(contents).map(([field, value]) =>
    Array.isArray(value)
      ? { field, count: value.length, items: value.map(itemText) }
      : { field, items: value === null || value === undefined ? [] : [itemText(value)] },
  );
}

/** The starter is recorded on the start card, independent of later handoffs or transfers. */
export function workflowStarterLine(run: import('@beeline/api-contract/phone').WorkflowRunSummaryView): string {
  const name = run.startedBy?.name;
  if (!name) return '';
  return run.startKind === 'schedule' ? `Schedule (as ${name})` : run.startKind === 'human_admin' ? `${name} · human admin` : run.startKind === 'owner' ? `${name} · owner` : name;
}
