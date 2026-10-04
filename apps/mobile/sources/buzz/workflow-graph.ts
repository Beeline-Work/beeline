import type {
  WorkflowActorView,
  WorkflowContract,
  WorkflowGateRecordView,
  WorkflowOpenedCornerView,
  WorkflowRunStepView,
  WorkflowState,
  WorkflowReceipt,
} from '@beeline/api-contract/phone';

/**
 * The run's reached visits in execution order (including repeated states),
 * followed by the contract's predicted forward path from the current state —
 * each state's first declared outcome, stopping at the first predicted
 * terminal — so the rail always shows every step of the workflow, not only
 * the ones the run has reached so far.
 */

export type WorkflowLineStatus = 'done' | 'current' | 'pending' | 'skipped' | 'failed';

export type WorkflowLineKind = 'handoff' | 'gate' | 'server' | 'waiting' | 'terminal';

/** One stay in a state, from the card that entered it to the card that left it. */
export type WorkflowLineVisit = {
  readonly outputTurns?: readonly string[];
  readonly liveOutput?: string;
  readonly finalReply?: WorkflowRunStepView['finalReply'];
  readonly enteredAt: number;
  readonly leftAt?: number;
  /** The outcome the run left by, and the state it went to. */
  readonly outcome?: string;
  readonly nextState?: string;
  /** Who wrote the card that left the state. */
  readonly leftBy?: WorkflowActorView;
  /** What the state handed off with. */
  readonly delivered?: Readonly<Record<string, unknown>>;
  readonly receipt?: WorkflowReceipt;
  readonly gate?: WorkflowGateRecordView;
  readonly openedCorners?: readonly WorkflowOpenedCornerView[];
};

export type WorkflowLineStep = {
  readonly visitId?: string;
  readonly state: string;
  readonly kind: WorkflowLineKind;
  readonly terminalStatus?: 'done' | 'failed' | 'abandoned';
  readonly status: WorkflowLineStatus;
  /** False for a state spliced in because the run went through it. */
  readonly onMainPath: boolean;
  readonly visits: readonly WorkflowLineVisit[];
  /** For a skipped state: the visited state whose outcome went around it. */
  readonly skippedBy?: { readonly state: string; readonly outcome?: string };
  /** For a state that owns a capped loop: times its loop edge was taken, and the cap. */
  readonly loop?: { readonly taken: number; readonly cap: number };
};

function kindOf(state: WorkflowState | undefined): WorkflowLineKind {
  return state?.kind ?? 'handoff';
}

/** The state `state`'s first declared outcome not already in `seen`, or a fresh implicit terminal. */
function nextPredicted(
  contract: WorkflowContract,
  state: string,
  seen: ReadonlySet<string>,
): string | undefined {
  const declared = contract.handoffs[state];
  if (!declared || declared.kind === 'terminal' || declared.kind === 'waiting') return undefined;
  const forward = Object.entries(declared.on).find(([, target]) => !seen.has(target));
  return (
    forward?.[1] ??
    (contract.implicitEdges ?? []).find(
      (name) => contract.handoffs[name]?.kind === 'terminal' && !seen.has(name),
    )
  );
}

/** The contract's predicted path onward from the run's current state, every row `pending`. */
function predictedTail(
  contract: WorkflowContract,
  current: string,
  reachedStates: ReadonlySet<string>,
): WorkflowLineStep[] {
  const seen = new Set(reachedStates);
  const tail: WorkflowLineStep[] = [];
  let state = nextPredicted(contract, current, seen);
  while (state !== undefined) {
    const declared = contract.handoffs[state]!;
    seen.add(state);
    tail.push({
      state,
      kind: kindOf(declared),
      ...(declared.kind === 'terminal' ? { terminalStatus: declared.status } : {}),
      status: 'pending',
      onMainPath: true,
      visits: [],
    });
    if (declared.kind === 'terminal') break;
    state = nextPredicted(contract, state, seen);
  }
  return tail;
}

export function workflowRunLine(
  contract: WorkflowContract,
  history: readonly WorkflowRunStepView[] = [],
): WorkflowLineStep[] {
  const entries = history.filter((entry) => contract.handoffs[entry.toState]);
  const reached = entries.map<WorkflowLineStep>((entry, index, entries) => {
    const declared = contract.handoffs[entry.toState]!;
    const next = entries[index + 1];
    const terminal = declared.kind === 'terminal';
    const visit: WorkflowLineVisit = {
      enteredAt: entry.at,
      ...(next ? {
        leftAt: next.at,
        outcome: next.outcome,
        nextState: next.toState,
        leftBy: next.actor,
        delivered: next.contents,
        receipt: next.receipt,
      } : terminal ? { leftAt: entry.at } : {}),
      gate: entry.gate,
      openedCorners: entry.openedCorners,
      outputTurns: entry.outputTurns,
      liveOutput: entry.liveOutput,
      finalReply: entry.finalReply,
    };
    return {
      visitId: entry.visitId ?? String(index),
      state: entry.toState,
      kind: kindOf(declared),
      ...(terminal ? { terminalStatus: declared.status } : {}),
      status: terminal && declared.status !== 'done' ? 'failed' : next || terminal ? 'done' : 'current',
      onMainPath: false,
      visits: [visit],
    };
  }).filter((step, index) => !(entries[index]?.status === 'abandoned' && entries[index]?.fromState === entries[index]?.toState));
  const last = reached[reached.length - 1];
  if (!last || last.status !== 'current') return reached;
  return [...reached, ...predictedTail(contract, last.state, new Set(reached.map((step) => step.state)))];
}

/** `feedback-triage` → `Feedback triage`. */
export function workflowDisplayName(slug: string): string {
  return sentence(slug);
}

/** `ask_human` → `Ask human`. */
export function workflowStateLabel(state: string): string {
  return sentence(state);
}

function sentence(value: string): string {
  const words = value.replace(/[_-]+/g, ' ').trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : value;
}
