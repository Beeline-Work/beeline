import type {
  WorkflowActorView,
  WorkflowContract,
  WorkflowGateRecordView,
  WorkflowOpenedCornerView,
  WorkflowRunStepView,
  WorkflowState,
  WorkflowReceipt,
} from '@beeline/api-contract/phone';

/** The run's reached visits in execution order, including repeated states. */

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

export function workflowRunLine(
  contract: WorkflowContract,
  history: readonly WorkflowRunStepView[] = [],
): WorkflowLineStep[] {
  const entries = history.filter((entry) => contract.handoffs[entry.toState]);
  return entries.map<WorkflowLineStep>((entry, index, entries) => {
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
