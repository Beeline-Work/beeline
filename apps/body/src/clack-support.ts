/**
 * Shared clack prompt plumbing so every interactive `beeline` flow cancels
 * (Ctrl-C/Esc) the same way: a clean one-line message, never a stack trace.
 */
import * as clack from '@clack/prompts';
import { stdout } from 'node:process';

const FALLBACK_TERMINAL_COLUMNS = 80;
const FALLBACK_TERMINAL_ROWS = 24;

/**
 * Clack wraps every rendered line to `output.columns`. Some real pseudo-TTYs
 * report `isTTY=true` but expose a zero-sized window; clack then wraps every
 * character onto its own line and the next picker appears to vanish below the
 * completed spinner. Preserve the real stream while substituting ordinary
 * dimensions only for those invalid terminal measurements.
 */
export function clackPromptOutput(output: NodeJS.WriteStream = stdout): NodeJS.WriteStream {
  // @clack/core's Prompt renderer reads `process.stdout.columns` directly,
  // even when a custom output stream is supplied. Repair the real TTY's
  // invalid dimensions in place so both that renderer and clack's outer
  // helpers agree on one usable size.
  if (!Number.isFinite(output.columns) || output.columns < 20) {
    output.columns = FALLBACK_TERMINAL_COLUMNS;
  }
  if (!Number.isFinite(output.rows) || output.rows < 5) {
    output.rows = FALLBACK_TERMINAL_ROWS;
  }
  return output;
}

/**
 * Unwrap a clack prompt result, exiting cleanly on cancel instead of letting
 * the cancel symbol propagate into caller logic. `process.exit` is typed
 * `never`, so callers get `value` narrowed to `T` after this returns.
 */
export function unwrapPrompt<T>(
  value: T | Extract<Awaited<ReturnType<typeof clack.text>>, symbol>,
  cancelMessage = 'Cancelled.',
): T {
  if (clack.isCancel(value)) {
    clack.cancel(cancelMessage);
    process.exit(1);
  }
  return value;
}
