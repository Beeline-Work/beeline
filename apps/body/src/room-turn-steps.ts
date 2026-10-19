import type { DaemonOperationMap } from '@beeline/api-contract/daemon';
import type { AgentTurnStep } from './acp.js';
import { redactToolDetail } from './turn-failure-reason.js';

type DaemonActivity = DaemonOperationMap['postAgentActivity']['input']['activity'][number];

/** The server's bounds on a reply's steps (`daemon-service.ts`). */
export const MAX_REPLY_STEPS = 200;
export const MAX_NOTE_LENGTH = 16_000;

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * A Room turn's steps as the activity its reply carries: each earlier text
 * run as a note, in full up to the server's bound, and each tool call as a
 * redacted one-line ledger row. Order is the turn's own.
 */
export function roomReplySteps(
  steps: readonly AgentTurnStep[],
  requestedBy?: { pubkey: string; name?: string },
): DaemonActivity[] {
  return steps.slice(-MAX_REPLY_STEPS).map((step): DaemonActivity => {
    if (step.kind === 'note') {
      return { kind: 'note', title: 'Note', text: step.text.slice(0, MAX_NOTE_LENGTH) };
    }
    const operation = oneLine(step.call.kind ?? '') || 'tool';
    const title = oneLine(redactToolDetail(step.call.title ?? '')) || `${operation} tool`;
    return {
      kind: 'tool',
      title: title.slice(0, 240),
      operation: operation.slice(0, 80),
      status: step.call.status ?? 'completed',
      ...(requestedBy ? { requestedBy } : {}),
    };
  });
}
