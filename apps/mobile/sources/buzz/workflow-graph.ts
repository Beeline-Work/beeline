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
 * The run page's line, laid out as data (DESIGN.md → Workflows).
 *
 * One straight line, one row per state: the contract's main path — from
 * `start`, each state's first `on` outcome, to a terminal — with any state the
 * run visited off that path spliced in after the state the run entered it
 * from. A loop never draws back up the line: a state entered more than once is
 * one row with every visit on it.
 *
 * Pure: contract + the run's ordered handoff history in, ordered steps out.
 */

export type WorkflowLineStatus = 'done' | 'current' | 'pending' | 'skipped' | 'failed';

export type WorkflowLineKind = 'handoff' | 'gate' | 'server' | 'waiting' | 'terminal';

/** One stay in a state, from the card that entered it to the card that left it. */
export type WorkflowLineVisit = {
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

function outcomesOf(state: WorkflowState | undefined): Array<[string, string]> {
  if (!state || state.kind === 'terminal' || state.kind === 'waiting') return [];
  return Object.entries(state.on);
}

/**
 * `start`, then each state's first outcome. When that outcome returns to a
 * state already on the line, the next outcome that goes somewhere new is
 * taken; with none, the first `implicitEdges` terminal ends the line.
 */
export function workflowMainPath(contract: WorkflowContract): string[] {
  const path: string[] = [];
  let state: string | undefined = contract.start;
  while (state !== undefined && contract.handoffs[state] && !path.includes(state)) {
    path.push(state);
    const declared: WorkflowState = contract.handoffs[state]!;
    if (declared.kind === 'terminal') break;
    const forward: [string, string] | undefined = outcomesOf(declared).find(
      ([, target]) => !path.includes(target),
    );
    state =
      forward?.[1] ??
      (contract.implicitEdges ?? []).find(
        (name) => contract.handoffs[name]?.kind === 'terminal' && !path.includes(name),
      );
  }
  return path;
}

export function workflowRunLine(
  contract: WorkflowContract,
  history: readonly WorkflowRunStepView[] = [],
): WorkflowLineStep[] {
  const order = workflowMainPath(contract);
  const main = new Set(order);
  for (const step of history) {
    if (order.includes(step.toState) || !contract.handoffs[step.toState]) continue;
    const after = step.fromState !== undefined ? order.indexOf(step.fromState) : -1;
    order.splice(after < 0 ? order.length : after + 1, 0, step.toState);
  }

  const visits = new Map<string, WorkflowLineVisit[]>();
  history.forEach((step, index) => {
    const next = history[index + 1];
    const left = next && next.fromState === step.toState ? next : undefined;
    const list = visits.get(step.toState) ?? [];
    list.push({
      enteredAt: step.at,
      ...(left
        ? {
            leftAt: left.at,
            ...(left.outcome !== undefined ? { outcome: left.outcome } : {}),
            nextState: left.toState,
            ...(left.actor ? { leftBy: left.actor } : {}),
            ...(left.contents ? { delivered: left.contents } : {}),
            ...(left.receipt ? { receipt: left.receipt } : {}),
          }
        : {}),
      ...(step.gate ? { gate: step.gate } : {}),
      ...(step.openedCorners?.length ? { openedCorners: step.openedCorners } : {}),
    });
    visits.set(step.toState, list);
  });

  const last = history[history.length - 1];
  const ended = last !== undefined && contract.handoffs[last.toState]?.kind === 'terminal';
  const current = last !== undefined && !ended ? last.toState : undefined;
  // The furthest row the run reached: anything unvisited above it was gone around.
  const reached = Math.max(-1, ...order.map((state, index) => (visits.has(state) ? index : -1)));

  return order.map((state, index) => {
    const declared = contract.handoffs[state];
    const stateVisits = visits.get(state) ?? [];
    const loop = declared && 'loop' in declared ? declared.loop : undefined;
    let status: WorkflowLineStatus;
    if (state === current) status = 'current';
    else if (stateVisits.length > 0)
      status =
        declared?.kind === 'terminal' && declared.status !== 'done' ? 'failed' : 'done';
    else status = ended || index < reached ? 'skipped' : 'pending';
    let skippedBy: WorkflowLineStep['skippedBy'];
    if (status === 'skipped') {
      for (let above = index - 1; above >= 0; above -= 1) {
        const from = visits.get(order[above]!);
        if (!from) continue;
        const exit = from[from.length - 1]!;
        skippedBy = {
          state: order[above]!,
          ...(exit.outcome !== undefined ? { outcome: exit.outcome } : {}),
        };
        break;
      }
    }
    return {
      state,
      kind: kindOf(declared),
      ...(declared?.kind === 'terminal' ? { terminalStatus: declared.status } : {}),
      status,
      onMainPath: main.has(state),
      visits: stateVisits,
      ...(skippedBy ? { skippedBy } : {}),
      ...(loop
        ? {
            loop: {
              taken: history.filter(
                (step) => step.fromState === state && step.outcome === loop.onEdge,
              ).length,
              cap: loop.cap,
            },
          }
        : {}),
    };
  });
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
