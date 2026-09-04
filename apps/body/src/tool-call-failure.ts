/**
 * One journal line for a tool call the harness reports as failed.
 *
 * A refused `open_corner` used to leave the helper journal with the call and
 * nothing after it: no status, no reason, nothing an operator could read. The
 * agent said only "the last open_corner call was rejected" and the same turn
 * failed twice (C90). The refusal sentence does exist on the wire — in the
 * call's `content`, or, for grok, only in its `rawOutput.output.Error` — so
 * the helper reads whichever one carries it and says it out loud.
 */
import type { ToolCallEntry } from './acp.js';
import { redactToolDetail } from './turn-failure-reason.js';

const MAX_DETAIL = 300;

/** Pull the readable text out of an ACP tool call's content, whatever shape it took. */
function toolCallText(content: unknown): string {
  const parts: string[] = [];
  const walk = (value: unknown, depth: number): void => {
    if (depth > 4 || parts.length > 8) return;
    if (typeof value === 'string') {
      parts.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
      return;
    }
    if (!value || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    // grok names the key `Error` and nests it under `output`; other harnesses
    // use `text`/`message`. Match on the lowercased key so neither is missed.
    for (const [key, nested] of Object.entries(record)) {
      if (['text', 'content', 'message', 'error', 'output'].includes(key.toLowerCase())) {
        walk(nested, depth + 1);
      }
    }
  };
  walk(content, 0);
  return parts.join(' ');
}

/** True when the harness reported this call as refused or errored. */
export function isFailedToolCall(call: ToolCallEntry): boolean {
  return /^(?:failed|error|denied|rejected)$/i.test(call.status ?? '');
}

/**
 * The line to log for a failed tool call, or `undefined` when the call did
 * not fail. Secrets are scrubbed with the same redactor the failed-turn
 * receipt uses, and the detail is capped — this is a log line, not a dump.
 */
export function toolCallFailureLine(call: ToolCallEntry): string | undefined {
  if (!isFailedToolCall(call)) return undefined;
  const title = call.title?.trim() || call.id || 'tool';
  const detail = redactToolDetail(toolCallText(call.content) || toolCallText(call.rawOutput))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_DETAIL);
  return detail ? `${title} refused: ${detail}` : `${title} refused with no reason given`;
}
