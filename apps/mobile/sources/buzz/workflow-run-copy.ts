import type { Href } from 'expo-router';
import type {
  WorkflowActorView,
  WorkflowReadContract,
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

/** `nothing_new` → `nothing new`. */
export function outcomeLabel(outcome: string): string {
  return workflowStateLabel(outcome).toLowerCase();
}

function capitalized(line: string): string {
  return line ? `${line[0]!.toUpperCase()}${line.slice(1)}` : line;
}

/** The role a state names, if any. */
export function stateRole(contract: WorkflowReadContract, state: string): string | undefined {
  const declared = contract.handoffs[state];
  if (!declared || declared.kind === 'terminal') return undefined;
  return declared.role;
}

/**
 * Who holds or held a step, drawn at the row's right: the run's holder for the
 * current step (the viewer when it waits on them), whoever left a reached step
 * (the person who answered a gate), and the identity bound to a pending step's
 * role. A step with no role has none.
 */
export function workflowStepAssignee(
  step: WorkflowLineStep,
  input: {
    contract: WorkflowReadContract;
    roleHolders: Readonly<Record<string, WorkflowActorView>>;
    run: Pick<WorkflowRunSummaryView, 'viewerHolds' | 'holder'>;
    viewer?: WorkflowActorView;
  },
): WorkflowActorView | undefined {
  const role = stateRole(input.contract, step.state);
  if (!role) return undefined;
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
 * server runs it. Who holds a step is its mark
 * (`workflowStepAssignee`), so no name is repeated here.
 */
export function workflowStepMeta(
  step: WorkflowLineStep,
  input: {
    contract: WorkflowReadContract;
    run: Pick<WorkflowRunSummaryView, 'viewerHolds'>;
    history: readonly { fromState?: string; toState: string }[];
  },
): string {
  const roleless = !stateRole(input.contract, step.state);
  const automatic = !roleless
    ? undefined
    : step.kind === 'server' ? 'Automatic' : step.kind === 'waiting' ? 'Waiting' : undefined;
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
      ? [step.kind === 'gate' ? 'Your call' : 'Waiting on you', step.kind === 'gate' ? 'gate' : undefined]
      : [automatic];
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
 * The run's status line, as GitHub Actions heads a run: whose move it is, or
 * how it ended. The rail below names which step is current.
 */
export function workflowRunHeadline(
  run: Pick<WorkflowRunSummaryView, 'status' | 'viewerHolds'>,
  lastOutcome?: string,
): string {
  if (run.status === 'live') return run.viewerHolds ? 'Waiting on you' : 'Running';
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

/** The starter is recorded on the start card, independent of later handoffs or transfers. */
export function workflowStarterLine(run: import('@beeline/api-contract/phone').WorkflowRunSummaryView): string {
  const name = run.startedBy?.name;
  if (!name) return '';
  return run.startKind === 'schedule' ? `Schedule (as ${name})` : run.startKind === 'human_admin' ? `${name} · human admin` : name;
}
