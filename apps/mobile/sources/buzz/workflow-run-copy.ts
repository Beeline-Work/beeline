import type { Href } from 'expo-router';
import type {
  WorkflowActorView,
  WorkflowContract,
  WorkflowRunSummaryView,
} from '@beeline/api-contract/phone';
import { cornerHref, roomHref } from './corner-navigation';
import { workflowStateLabel, type GraphRow } from './workflow-graph';

/** The run page for one workflow run. */
export function workflowRunHref(run: Pick<WorkflowRunSummaryView, 'roomId' | 'runId'>): Href {
  return {
    pathname: '/beeline/workflow-run',
    params: { roomId: run.roomId, runId: run.runId },
  } as unknown as Href;
}

/** The corner (or Room) the run's cards live in. */
export function workflowRunRoomHref(
  run: Pick<WorkflowRunSummaryView, 'roomId' | 'roomName' | 'parentRoomId'>,
): Href {
  return run.parentRoomId
    ? cornerHref(run.roomId, run.parentRoomId, run.roomName)
    : roomHref(run.roomId);
}

const TERMINAL_LABEL = { done: 'Done', failed: 'Failed', abandoned: 'Abandoned' } as const;

/** `round 2 of 3`: the current trip out of the loop's cap. Hidden until the run has taken the loop edge once. */
export function loopRoundLabel(loop: GraphRow['loop']): string | undefined {
  if (!loop || loop.taken < 1) return undefined;
  return `round ${Math.min(loop.taken + 1, loop.cap)} of ${loop.cap}`;
}

function outcomeLabel(outcome: string): string {
  return workflowStateLabel(outcome).toLowerCase();
}

function holderOf(
  contract: WorkflowContract,
  state: string,
  roleHolders: Readonly<Record<string, WorkflowActorView>>,
): string | undefined {
  const declared = contract.handoffs[state];
  if (!declared || declared.kind === 'terminal') return undefined;
  return declared.role ? roleHolders[declared.role]?.name : undefined;
}

/**
 * A row's one meta line: who holds the state and how the run left it, the
 * current step's claim on the viewer, or a terminal's status.
 */
export function workflowRowMeta(
  row: GraphRow,
  input: {
    contract: WorkflowContract;
    roleHolders: Readonly<Record<string, WorkflowActorView>>;
    run: Pick<WorkflowRunSummaryView, 'viewerHolds' | 'holder'>;
  },
): string {
  if (row.kind === 'terminal') {
    const status = TERMINAL_LABEL[row.terminalStatus ?? 'done'];
    const why =
      row.inOutcomes.length > 0
        ? row.inOutcomes.map(outcomeLabel).join(' or ')
        : row.implicit
          ? 'From any step'
          : undefined;
    return why ? `${why[0]!.toUpperCase()}${why.slice(1)} · ${status}` : status;
  }
  const holder =
    row.reach === 'current'
      ? (input.run.holder?.name ?? holderOf(input.contract, row.state, input.roleHolders))
      : holderOf(input.contract, row.state, input.roleHolders);
  const fallback = row.kind === 'server' ? 'Automatic' : row.kind === 'waiting' ? 'Waiting' : undefined;
  const round = loopRoundLabel(row.loop);
  const parts =
    row.reach === 'current'
      ? input.run.viewerHolds
        ? ['Waiting on you', round]
        : [holder ?? fallback, round]
      : row.reach === 'traversed'
        ? [holder, row.lastOutcome ? outcomeLabel(row.lastOutcome) : undefined, round]
        : [holder ?? fallback];
  const line = parts.filter((part): part is string => Boolean(part)).join(' · ');
  return line ? `${line[0]!.toUpperCase()}${line.slice(1)}` : '';
}

/** The corner line's state word: the viewer's turn, who holds it, or how the run ended. */
export function workflowRunStateWord(
  run: Pick<WorkflowRunSummaryView, 'status' | 'viewerHolds' | 'holder'>,
): string {
  if (run.status !== 'live') return TERMINAL_LABEL[run.status].toLowerCase();
  if (run.viewerHolds) return 'waiting on you';
  return run.holder ? run.holder.name : 'working';
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
