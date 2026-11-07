import type { DaemonOperationMap } from '@beeline/api-contract/daemon';
import { toolCallText } from './tool-call-failure.js';
import type { AgentTurnStep } from './acp.js';
import { redactToolDetail } from './turn-failure-reason.js';

type DaemonActivity = DaemonOperationMap['postAgentActivity']['input']['activity'][number];

/** The server's bounds on a reply's steps (`daemon-service.ts`). */
export const MAX_REPLY_STEPS = 2_000;
export const MAX_NOTE_LENGTH = 16_000;

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/** Split text into pieces no longer than the note bound, never inside a surrogate pair. */
function notePieces(text: string): string[] {
  const pieces: string[] = [];
  let rest = text;
  while (rest.length > MAX_NOTE_LENGTH) {
    let cut = MAX_NOTE_LENGTH;
    const code = rest.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
    pieces.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  pieces.push(rest);
  return pieces;
}

/**
 * A Room turn's steps as the activity its reply carries: each earlier text
 * run as a note and each tool call as a one-line ledger row, in the
 * turn's own order.
 *
 * Notes are the agent's words and are never cut or dropped. A run longer
 * than one note may be is split across consecutive notes (`continues`), which
 * the phone joins back into one. When the steps exceed the server's count
 * bound, the oldest tool rows give way, folded into one counted row.
 */
export function roomReplySteps(
  steps: readonly AgentTurnStep[],
  requestedBy?: { pubkey: string; name?: string },
): DaemonActivity[] {
  const pieces = steps.map((step) => (step.kind === 'note' ? notePieces(step.text) : []));
  const noteRows = pieces.reduce((sum, list) => sum + list.length, 0);
  const tools = steps.length - pieces.filter((list) => list.length).length;
  const room = Math.max(0, MAX_REPLY_STEPS - noteRows);
  // Every note first; then the newest tools, with one row counting the rest.
  const folded = noteRows + tools > MAX_REPLY_STEPS ? tools - Math.max(0, room - 1) : 0;
  const rows: DaemonActivity[] = [];
  let skipped = 0;
  steps.forEach((step, index) => {
    if (step.kind === 'note') {
      pieces[index]!.forEach((text, part) =>
        rows.push({ kind: 'note', title: 'Note', text, ...(part ? { continues: true } : {}) }),
      );
      return;
    }
    if (skipped < folded) {
      skipped += 1;
      if (skipped === folded && room > 0) {
        rows.push({
          kind: 'tool',
          title: `${folded} earlier steps`,
          operation: 'tool',
          status: 'completed',
          ...(requestedBy ? { requestedBy } : {}),
        });
      }
      return;
    }
    const operation = oneLine(step.call.kind ?? '') || 'tool';
    const title = oneLine(redactToolDetail(step.call.title ?? '')) || `${operation} tool`;
    const identity = `${step.call.name ?? ''} ${step.call.title ?? ''} ${JSON.stringify(step.call.rawInput ?? {})}`;
    // Credential paths suppress output regardless of the command used to access them.
    const secret = /fetch_credential|read_credential|raw_credential|[._]netrc\b|\.pgpass\b|\.git-credentials\b|\.npmrc\b|\.pypirc\b|\.docker[\\/]+config\.json\b|\.aws[\\/]+credentials\b|\.env|credentials|\bid_[a-z0-9_]+\b|\.(?:pem|key)\b|private.?key/i.test(identity);
    const raw = secret ? '' : redactToolDetail(toolCallText(step.call.content) || toolCallText(step.call.rawOutput));
    const bytes = Buffer.from(raw);
    const marker = '\n[cut off]';
    const output = secret ? 'Output hidden: contains a secret.' : bytes.length > 4096
      ? bytes.subarray(0, 4096 - Buffer.byteLength(marker)).toString('utf8').replace(/\ufffd$/, '') + marker
      : raw;
    rows.push({
      kind: 'tool',
      title: title.slice(0, 240),
      operation: operation.slice(0, 80),
      status: step.call.status ?? 'completed',
      ...(output ? { output } : {}),
      ...(requestedBy ? { requestedBy } : {}),
    });
  });
  return rows;
}
