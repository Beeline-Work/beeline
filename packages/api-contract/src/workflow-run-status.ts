import type { WorkflowContract } from './workflow-contracts.js';
import type { WorkflowRunStatus } from './phone-operations.js';

export type WorkflowStepDisplayStatus = 'current' | 'done' | 'failed';

/** A recorded close overrides the definition, including a close in a nonterminal state. */
export function workflowRunStatus(
  contract: WorkflowContract,
  state: string,
  recorded?: WorkflowRunStatus,
): WorkflowRunStatus {
  const declared = contract.handoffs[state];
  return recorded ?? (declared?.kind === 'terminal' ? declared.status : 'live');
}

/** Only the last visit of a live run can be current. */
export function workflowStepDisplayStatus(
  contract: WorkflowContract,
  state: string,
  runStatus: WorkflowRunStatus,
  left: boolean,
): WorkflowStepDisplayStatus {
  const declared = contract.handoffs[state];
  if (declared?.kind === 'terminal') return declared.status === 'done' ? 'done' : 'failed';
  if (left) return 'done';
  return runStatus === 'live' ? 'current' : runStatus === 'failed' ? 'failed' : 'done';
}
