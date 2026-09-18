import type { TurnActivityAction } from '@/buzz/activity-timeline';
import {
  formatToolCallDuration,
  TOOL_CALL_DURATION_FLOOR_MS,
  toolCallLabel,
  toolCallOutput,
} from './tool-call-row';

/**
 * The one-line tool ledger (owner-approved design, 2026-08-24).
 *
 * Every settled machine step is ONE collapsed ledger line: a leading family
 * glyph, the verb-object label, a quiet verdict mark, and — only when the step
 * actually carries one — a right-gutter duration. No cards, no chips. A failed
 * step carries its distilled failure reason inline; a tap opens the full raw
 * output in the Hull output sheet. Every machine run folds into one group
 * line (`⌄ 6 steps · 2 failed · 48s`) that expands in place. This is
 * true even for a one-step run: narration defines the run boundary, not an
 * arbitrary minimum number of calls.
 *
 * The glyph vocabulary is deliberately three marks and a fallback, all already
 * spoken elsewhere in the product's mono chrome:
 *
 *   `>_`  shell/execute — the prompt glyph, the one family with two characters
 *   `≡`   file work (read, write, edit, patch, list, search, move, delete)
 *   `⋯`   thought — the fold glyph: reasoning is folded content, shown only
 *         through the sheet
 *   `·`   everything else (web fetch, MCP, unknown) — quiet by default
 *
 * Colour is spent in exactly two places: the brass `✗` and the group's failed
 * count — both needs-attention facts (the design supersedes C88's red failure
 * text in the row; the diff reds stay for the actual code diff). A successful
 * step's `✓` is the dimmest chrome, and a running step uses the product's
 * existing spinner treatment in the verdict slot.
 *
 * Durations are shown only from existing receipts. A step with no duration
 * omits the gutter rather than faking one.
 */

const GLYPH_SHELL = '>_';
const GLYPH_FILE = '≡';
const GLYPH_THOUGHT = '⋯';
const GLYPH_TOOL = '·';

const FILE_VERBS = new Set([
  'read',
  'write',
  'edit',
  'patch',
  'list',
  'search',
  'move',
  'delete',
  'glob',
  'grep',
]);

export function toolGlyph(step: Pick<TurnActivityAction, 'kind' | 'toolKind'>): string {
  if (step.kind === 'thought') return GLYPH_THOUGHT;
  const verb = step.toolKind?.toLowerCase() ?? '';
  if (verb === 'execute') return GLYPH_SHELL;
  if (FILE_VERBS.has(verb)) return GLYPH_FILE;
  return GLYPH_TOOL;
}

export type ToolLedgerLine = {
  id: string;
  kind: 'tool' | 'thought';
  glyph: string;
  label: string;
  outcome: 'running' | 'success' | 'failure';
  /** Distilled failure reason, inline on the line; undefined on success. */
  reason?: string;
  /** From existing receipts only; undefined means the gutter is omitted. */
  durationMs?: number;
  /** The sheet body: full raw output, files, reason. Undefined = not pressable. */
  detail?: string;
  files?: readonly { path: string; status?: string }[];
};

/**
 * One ledger line per step, in turn order. The turn's final step on a live
 * turn reads as running — the same live override the previous renderer applied
 * — so the row the agent is inside right now carries the spinner.
 */
export function toolLedgerLines(
  steps: readonly TurnActivityAction[],
  live = false,
): ToolLedgerLine[] {
  return steps.map((step, index) => {
    const isCurrent = live && index === steps.length - 1;
    const outcome: ToolLedgerLine['outcome'] = isCurrent ? 'running' : step.outcome;
    // A duration only earns a gutter above the floor (`tool-call-row.ts`); a
    // faster step omits it rather than faking one.
    const durationMs =
      step.durationMs && step.durationMs >= TOOL_CALL_DURATION_FLOOR_MS
        ? step.durationMs
        : undefined;
    return {
      id: step.id,
      kind: step.kind,
      glyph: toolGlyph(step),
      // A thought's own label already says `thought`; a tool's label is the
      // call's object (tool-call-row.ts) — the glyph carries the family.
      label: step.kind === 'thought' ? step.label : toolCallLabel(step),
      outcome,
      ...(outcome === 'failure' && step.reason ? { reason: step.reason } : {}),
      ...(durationMs ? { durationMs } : {}),
      ...(step.files?.length ? { files: step.files } : {}),
      ...detailOf(step),
    };
  });
}

function detailOf(step: TurnActivityAction): Pick<ToolLedgerLine, 'detail'> | {} {
  const parts: string[] = [];
  if (step.reason) parts.push(step.reason);
  for (const file of step.files ?? []) {
    parts.push(file.status ? `${file.status} ${file.path}` : file.path);
  }
  const output = toolCallOutput(step.output).join('\n');
  if (output) parts.push(output);
  if (step.requestedBy) {
    parts.push(
      step.requestedBy.name ? `at ${step.requestedBy.name}'s request` : "at a grant's request",
    );
  }
  return parts.length ? { detail: parts.join('\n') } : {};
}

export type ToolLedgerRun = {
  kind: 'group';
  id: string;
  count: number;
  failed: number;
  durationMs?: number;
  lines: ToolLedgerLine[];
};

/**
 * Fold a machine run into one group line, collapsed by default and expandable
 * in place. Transcript narration separates calls before they reach this
 * function, so a short run must not be flattened back into individual rows.
 */
export function groupToolLedgerRuns(lines: readonly ToolLedgerLine[]): ToolLedgerRun[] {
  if (!lines.length) return [];
  const failed = lines.filter((line) => line.outcome === 'failure').length;
  const durations = lines
    .map((line) => line.durationMs)
    .filter((ms): ms is number => typeof ms === 'number');
  const durationMs = durations.length ? durations.reduce((sum, ms) => sum + ms, 0) : undefined;
  return [
    {
      kind: 'group',
      id: lines[0]!.id,
      count: lines.length,
      failed,
      ...(durationMs ? { durationMs } : {}),
      lines: [...lines],
    },
  ];
}

/** The group line's copy: `6 steps · 2 failed · 48s` — segments the run earned. */
export function toolGroupSummary(
  count: number,
  failed: number,
  durationMs: number | undefined,
): string {
  const segments = [`${count} ${count === 1 ? 'step' : 'steps'}`];
  if (failed > 0) segments.push(`${failed} failed`);
  const duration = formatToolCallDuration(durationMs);
  if (duration) segments.push(duration);
  return segments.join(' · ');
}
