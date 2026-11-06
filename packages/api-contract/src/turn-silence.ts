import { systemMessage } from './system-message-catalog.js';
/** Failed-receipt classification shared with the helper. Classification carries
 * diagnostics only; it never decides retry, expiry or notice policy. */

export const TURN_SILENCE_KINDS = [
  'hiccup',
  'wrong-model',
  'allowance-spent',
  'not-signed-in',
  'workspace-failure',
  'helper-out-of-date',
  'update-interrupted',
  'process-exited',
  'offline',
  'context-overflow',
  'resource-limit',
] as const;
export type TurnSilenceKind = (typeof TURN_SILENCE_KINDS)[number];

/** Wire `reasonKind` on a failed turn receipt, including the legacy model mark. */
export const TURN_RECEIPT_REASON_KINDS = [
  'hiccup',
  'wrong-model',
  'allowance-spent',
  'not-signed-in',
  'workspace-failure',
  'helper-out-of-date',
  'update-interrupted',
  'process-exited',
  'offline',
  'context-overflow',
  'resource-limit',
  'model-selection-unavailable',
] as const;
export type TurnReceiptReasonKind = (typeof TURN_RECEIPT_REASON_KINDS)[number];

export function isTurnReceiptReasonKind(value: unknown): value is TurnReceiptReasonKind {
  return (
    typeof value === 'string' && (TURN_RECEIPT_REASON_KINDS as readonly string[]).includes(value)
  );
}

export type ClassifiedTurnSilence = {
  readonly kind: TurnSilenceKind;
  /** Distilled fault named in the hiccup line; omitted for standing conditions. */
  readonly fault?: string;
  readonly allowanceUntil?: string;
  readonly repo?: string;
};

export function receiptKindToSilenceKind(kind: TurnReceiptReasonKind | undefined): TurnSilenceKind {
  if (kind === 'model-selection-unavailable' || kind === 'wrong-model') return 'wrong-model';
  if (kind && (TURN_SILENCE_KINDS as readonly string[]).includes(kind)) return kind;
  return 'hiccup';
}

const ALLOWANCE_UNTIL =
  /(?:try again at|until|resets?(?: at)?|available(?: again)?(?: at)?)\s+([A-Z][a-z]{2,9}\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}(?:\s+\d{1,2}:\d{2}(?:\s*[AP]M)?)?)/i;
const REPO_FROM_URL = /github\.com[:/]([^/\s]+\/[^/\s.]+?)(?:\.git)?(?:[/\s]|$)/i;
const REPO_FROM_SLUG = /\b([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\b/;

function firstMatch(value: string, pattern: RegExp): string | undefined {
  const match = value.match(pattern);
  const captured = match?.[1]?.trim();
  return captured || undefined;
}

/** Identify credential-shaped diagnostics before a failed receipt is distilled. */
export function isAuthShapedFault(text: string): boolean {
  return (
    /authentication required/i.test(text) ||
    /not signed in/i.test(text) ||
    /isn't signed in/i.test(text) ||
    /invalid api[_ -]?key/i.test(text) ||
    /\b401\b/.test(text)
  );
}

/**
 * The provider refused the request because input plus the requested output
 * exceed the model's context window (OpenRouter: "This endpoint's maximum
 * context length is 1048576 tokens. However, you requested about …"). A
 * restart resends the same oversized request, so it is not a hiccup.
 */
export function isContextOverflowFault(text: string): boolean {
  return (
    /maximum context length/i.test(text) ||
    /context[_ ]length[_ ]exceeded/i.test(text) ||
    /exceeds the context window/i.test(text) ||
    /prompt is too long/i.test(text) ||
    /input token count.*exceeds the maximum/i.test(text) ||
    /maximum prompt length is \d+/i.test(text)
  );
}

/**
 * Classify a distilled helper reason. `reasonKind` from a current helper wins;
 * text matching classifies diagnostic reasons that lack a kind.
 */
export function classifyTurnSilence(
  reason: string | null | undefined,
  reasonKind?: string,
): ClassifiedTurnSilence {
  // Match before honoring the legacy hiccup kind, and before a long absolute
  // harness path can hide the interpreter diagnostic behind the receipt cap.
  const missingInterpreter = (reason ?? '').match(/\benv:\s*[‘'"`]?([\w.+-]+)[’'"`]?\s*:\s*(?:No such file or directory|command not found)/i);
  if (missingInterpreter && /\bACP agent\b/.test(reason ?? '')) {
    const dependency = missingInterpreter[1]?.toLowerCase() === 'node' ? systemMessage("turn-silence.node") : systemMessage("turn-silence.its-interpreter");
    return {
      kind: 'hiccup',
      fault: systemMessage("turn-silence.it-couldn-t-start-the-background-service-can-t-find-install-on-th", dependency, dependency === 'Node' ? systemMessage("turn-silence.node") : systemMessage("turn-silence.the-required-interpreter")),
    };
  }
  if (/\bACP agent\b[^\n]*\bspawn\b[^\n]*\bENOENT\b/i.test(reason ?? '')) {
    return {
      kind: 'hiccup',
      fault: systemMessage("turn-silence.it-couldn-t-start-its-program-or-interpreter-is-missing-reinstall"),
    };
  }
  // JSON-RPC rejects the request shape before the model runs. Replaying it
  // cannot repair an incompatible adapter, even on a legacy hiccup receipt.
  if (/\bACP error -(?:32600|32601|32602)\b/i.test(reason ?? ''))
    return { kind: 'helper-out-of-date' };
  if (isTurnReceiptReasonKind(reasonKind)) {
    const kind = receiptKindToSilenceKind(reasonKind);
    if (kind === 'hiccup') {
      return { kind, fault: (reason ?? '').trim() || systemMessage("turn-silence.the-turn-stalled") };
    }
    return {
      kind,
      ...(kind === 'allowance-spent'
        ? { allowanceUntil: firstMatch(reason ?? '', ALLOWANCE_UNTIL) }
        : {}),
      ...(kind === 'workspace-failure' ? { repo: repoFromReason(reason ?? '') } : {}),
    };
  }
  const text = (reason ?? '').trim();
  if (!text) return { kind: 'hiccup', fault: systemMessage("turn-silence.the-turn-stalled") };

  if (
    /model selection unavailable/i.test(text) ||
    /isn't available/i.test(text) ||
    /not advertised/i.test(text)
  ) {
    return { kind: 'wrong-model' };
  }

  if (isContextOverflowFault(text)) {
    return { kind: 'context-overflow' };
  }

  if (/\bresource_limit: ACP session (?:exceeded|likely hit) its \d+ MiB memory limit\b/i.test(text)) {
    return { kind: 'resource-limit' };
  }

  if (
    /\b402\b/.test(text) ||
    /usage limit/i.test(text) ||
    /more credits/i.test(text) ||
    /quota/i.test(text) ||
    /allowance is spent/i.test(text)
  ) {
    return {
      kind: 'allowance-spent',
      allowanceUntil: firstMatch(text, ALLOWANCE_UNTIL),
    };
  }

  if (isAuthShapedFault(text)) {
    return { kind: 'not-signed-in' };
  }

  if (
    /command protocol/i.test(text) ||
    /refusing intake/i.test(text) ||
    /helper is out of date/i.test(text)
  ) {
    return { kind: 'helper-out-of-date' };
  }

  if (
    /working copy/i.test(text) ||
    /could not (?:clone|fetch|checkout)/i.test(text) ||
    /repository not found/i.test(text) ||
    /could not resolve host/i.test(text) ||
    /failed to start corner/i.test(text) ||
    /unable to access/i.test(text) ||
    /\bgit clone\b/i.test(text) ||
    /repository state is not verified/i.test(text) ||
    /incomplete repository binding/i.test(text) ||
    /no authoritative objective fact/i.test(text) ||
    /profile_busy/i.test(text) ||
    /broker unavailable/i.test(text)
  ) {
    return { kind: 'workspace-failure', repo: repoFromReason(text) };
  }

  if (/helper isn't running/i.test(text) || /helper is offline/i.test(text) || /helper is unreachable/i.test(text)) {
    return { kind: 'offline' };
  }

  const fault = text || systemMessage("turn-silence.the-turn-stalled");
  return { kind: 'hiccup', fault };
}

function repoFromReason(text: string): string {
  return firstMatch(text, REPO_FROM_URL) ?? firstMatch(text, REPO_FROM_SLUG) ?? systemMessage("turn-silence.the-repository");
}

/** The helper's one plain line for a repo cache it could not repair after a crash. */
export function repositoryCacheDamagedFault(cache: string, machine: string): string {
  return `The repo cache ${cache} on ${machine} is damaged and automatic repair failed. The machine's owner needs to repair it`;
}

/** Corner-start configuration that cannot recover without a human/config change. */
export function isStandingWorkspaceConfigurationFault(text: string): boolean {
  return (
    /repository state is not verified/i.test(text) ||
    /incomplete repository binding/i.test(text) ||
    /no authoritative objective fact/i.test(text)
  );
}
