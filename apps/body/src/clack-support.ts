/**
 * Shared clack prompt plumbing so every interactive `beeline` flow cancels
 * (Ctrl-C/Esc) the same way: a clean one-line message, never a stack trace.
 */
import * as clack from '@clack/prompts';
import pc from 'picocolors';

/**
 * Unwrap a clack prompt result, exiting cleanly on cancel instead of letting
 * the cancel symbol propagate into caller logic. `process.exit` is typed
 * `never`, so callers get `value` narrowed to `T` after this returns.
 */
export function unwrapPrompt<T>(value: T | symbol, cancelMessage = 'Cancelled.'): T {
  if (clack.isCancel(value)) {
    clack.cancel(cancelMessage);
    process.exit(1);
  }
  return value;
}

/**
 * Run `action` behind a clack spinner when `interactiveUi`, otherwise run it
 * plain — the non-interactive path is byte-identical to code with no spinner
 * at all, so a scripted/piped run never changes shape. A thrown error stops
 * the spinner in its "failed" state before propagating, so it never freezes
 * mid-render; the error itself is reported once, by the caller.
 */
export async function withSpinner<T>(
  interactiveUi: boolean,
  message: string,
  successMessage: string,
  action: () => Promise<T>,
): Promise<T> {
  if (!interactiveUi) return action();
  const spinnerHandle = clack.spinner();
  spinnerHandle.start(message);
  try {
    const result = await action();
    spinnerHandle.stop(pc.green(successMessage));
    return result;
  } catch (error) {
    spinnerHandle.stop(pc.red('Failed.'));
    throw error;
  }
}
