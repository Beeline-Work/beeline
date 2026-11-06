import { ModelSelectionUnavailableError } from './model-config.js';
import { classifyTurnSilence, type TurnReceiptReasonKind } from '@beeline/api-contract/daemon';

/**
 * One distilled line for a failed turn receipt. The Room carries a plain
 * failure; the full error stays in the daemon log. Never a stack trace,
 * at most 200 chars.
 */
export const TURN_FAILURE_REASON_MAX = 200;

export interface DistilledTurnFailureReason {
  readonly text: string;
  readonly kind?: TurnReceiptReasonKind;
}

/** Preserve diagnostic stacks in the helper journal. */
export function turnErrorDetail(error: unknown): string {
  return error instanceof Error ? error.stack || error.message : String(error);
}

export function distillTurnFailureReason(error: unknown): DistilledTurnFailureReason {
  if (error instanceof ModelSelectionUnavailableError) {
    return { text: 'model selection unavailable', kind: 'model-selection-unavailable' };
  }
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : error && typeof error === 'object' && 'message' in error
          ? String((error as { message: unknown }).message)
          : error == null
            ? ''
            : String(error);
  // ACP -32000 is the harness's explicit authentication-required refusal.
  // Unlike a provider token-refresh race, retrying it cannot sign the agent in.
  if (/^ACP error -32000: Authentication required(?:[.;]|$)/i.test(raw.trim())) {
    return { text: 'Authentication required: the agent needs to sign in again', kind: 'not-signed-in' };
  }
  const informative = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^at\s/.test(line));
  const firstLine = informative[0] ?? '';
  const stripped = firstLine.replace(/^(?:[A-Za-z]*Error|Error):\s*/, '').replace(/\s+/g, ' ');
  const classified = classifyTurnSilence(
    informative.join(' ').replace(/\s+/g, ' '),
  );
  const clean = classified.kind === 'hiccup' && classified.fault?.startsWith("it couldn't start:")
    ? classified.fault
    : stripped.trim();
  const text = !clean
    ? 'turn failed'
    : clean.length > TURN_FAILURE_REASON_MAX
      ? `${clean.slice(0, TURN_FAILURE_REASON_MAX - 1)}…`
      : clean;
  // Keep the diagnostic wire classification; the server records the result
  // without a retry budget or automatic escalation.
  const kind: TurnReceiptReasonKind =
    classified.kind === 'wrong-model'
      ? 'model-selection-unavailable'
      : classified.kind === 'not-signed-in'
        ? 'hiccup'
        : classified.kind;
  return { text, kind };
}
