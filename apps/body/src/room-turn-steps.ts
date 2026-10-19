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

function toolRow(
  title: string,
  operation: string,
  status: string,
  requestedBy?: { pubkey: string; name?: string },
): DaemonActivity {
  return {
    kind: 'tool',
    title: title.slice(0, 240),
    operation: operation.slice(0, 80),
    status,
    ...(requestedBy ? { requestedBy } : {}),
  };
}

/**
 * A Room turn's steps as the activity its reply carries: each earlier text
 * run as a note, whole, and each tool call as a redacted one-line ledger row,
 * in the turn's own order.
 *
 * Notes are the agent's words and are never cut. When the steps do not fit
 * the server's bounds, the oldest tool rows give way first, folded into one
 * counted row. When the notes alone cannot fit — one longer than a note may
 * be, or more notes than steps allowed — this returns `undefined` and the
 * caller must keep that text another way rather than drop it.
 */
export function roomReplySteps(
  steps: readonly AgentTurnStep[],
  requestedBy?: { pubkey: string; name?: string },
): DaemonActivity[] | undefined {
  const notes = steps.filter((step) => step.kind === 'note');
  if (notes.some((note) => note.text.length > MAX_NOTE_LENGTH)) return undefined;
  if (notes.length > MAX_REPLY_STEPS) return undefined;
  const tools = steps.length - notes.length;
  // Room for every note, then the newest tools; one row counts the rest.
  const folded = steps.length > MAX_REPLY_STEPS ? tools - (MAX_REPLY_STEPS - notes.length - 1) : 0;
  if (folded > 0 && MAX_REPLY_STEPS - notes.length < 1) return undefined;
  const rows: DaemonActivity[] = [];
  let skipped = 0;
  for (const step of steps) {
    if (step.kind === 'note') {
      rows.push({ kind: 'note', title: 'Note', text: step.text });
      continue;
    }
    if (skipped < folded) {
      skipped += 1;
      if (skipped === folded) {
        rows.push(toolRow(`${folded} earlier steps`, 'tool', 'completed', requestedBy));
      }
      continue;
    }
    const operation = oneLine(step.call.kind ?? '') || 'tool';
    const title = oneLine(redactToolDetail(step.call.title ?? '')) || `${operation} tool`;
    rows.push(toolRow(title, operation, step.call.status ?? 'completed', requestedBy));
  }
  return rows;
}
