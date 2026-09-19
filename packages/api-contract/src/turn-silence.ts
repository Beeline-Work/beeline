/**
 * First-silence vocabulary for a turn that did not answer.
 *
 * The Room line is phrased by the server through the one system-line grammar
 * (`<subject> <verb> · <consequence>`). This module owns the fault classes,
 * the approved remedies, the hiccup restart budget, and the 200-character cap.
 * Cost scales with messages that went unanswered, never with fleet size.
 */
import { MAX_EVENT_CONSEQUENCE_LENGTH, SYSTEM_LINE_SEPARATOR } from './system-events.js';

export const TURN_SILENCE_LINE_MAX = 200;
export const HICCUP_ATTEMPT_LIMIT = 3;
/** Backoff before restart N (1-indexed). Attempt 1 is immediate. */
export const HICCUP_BACKOFF_MS = [0, 5_000, 20_000] as const;

export const TURN_SILENCE_KINDS = [
  'hiccup',
  'wrong-model',
  'allowance-spent',
  'not-signed-in',
  'workspace-failure',
  'helper-out-of-date',
  'offline',
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
  'offline',
  'model-selection-unavailable',
] as const;
export type TurnReceiptReasonKind = (typeof TURN_RECEIPT_REASON_KINDS)[number];

export function isTurnReceiptReasonKind(value: unknown): value is TurnReceiptReasonKind {
  return (
    typeof value === 'string' &&
    (TURN_RECEIPT_REASON_KINDS as readonly string[]).includes(value)
  );
}

export type ClassifiedTurnSilence = {
  readonly kind: TurnSilenceKind;
  /** Distilled fault named in the hiccup line; omitted for standing conditions. */
  readonly fault?: string;
  readonly allowanceUntil?: string;
  readonly repo?: string;
};

export type TurnSilencePhrase = {
  readonly verb: string;
  readonly consequence: string;
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

/**
 * Classify a distilled helper reason. `reasonKind` from a current helper wins;
 * text matching covers old helpers and the 90s stall path (no receipt).
 */
export function classifyTurnSilence(
  reason: string | null | undefined,
  reasonKind?: string,
): ClassifiedTurnSilence {
  if (isTurnReceiptReasonKind(reasonKind)) {
    const kind = receiptKindToSilenceKind(reasonKind);
    if (kind === 'hiccup') {
      return { kind, fault: (reason ?? '').trim() || 'the turn stalled' };
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
  if (!text) return { kind: 'hiccup', fault: 'the turn stalled' };

  if (
    /model selection unavailable/i.test(text) ||
    /isn't available/i.test(text) ||
    /not advertised/i.test(text)
  ) {
    return { kind: 'wrong-model' };
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

  if (
    /authentication required/i.test(text) ||
    /not signed in/i.test(text) ||
    /isn't signed in/i.test(text) ||
    /invalid api[_ -]?key/i.test(text) ||
    /\b401\b/.test(text)
  ) {
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
    /repository state is not verified/i.test(text) ||
    /incomplete repository binding/i.test(text) ||
    /no authoritative objective fact/i.test(text)
  ) {
    return { kind: 'workspace-failure', repo: repoFromReason(text) };
  }

  if (/helper isn't running/i.test(text) || /helper is offline/i.test(text)) {
    return { kind: 'offline' };
  }

  const fault = text || 'the turn stalled';
  return { kind: 'hiccup', fault };
}

function repoFromReason(text: string): string {
  return firstMatch(text, REPO_FROM_URL) ?? firstMatch(text, REPO_FROM_SLUG) ?? 'the repository';
}

export function shouldRestartHiccup(kind: TurnSilenceKind, nextAttempt: number): boolean {
  return kind === 'hiccup' && nextAttempt > 0 && nextAttempt < HICCUP_ATTEMPT_LIMIT;
}

export function hiccupBackoffMs(attempt: number): number {
  const index = Math.max(1, attempt) - 1;
  return HICCUP_BACKOFF_MS[Math.min(index, HICCUP_BACKOFF_MS.length - 1)] ?? 0;
}

function capLine(name: string, verb: string, consequence: string): TurnSilencePhrase {
  const head = `${name} ${verb}${SYSTEM_LINE_SEPARATOR}`;
  const budget = Math.max(24, TURN_SILENCE_LINE_MAX - head.length);
  const clipped =
    consequence.length > budget ? `${consequence.slice(0, Math.max(1, budget - 1))}…` : consequence;
  const bounded =
    clipped.length > MAX_EVENT_CONSEQUENCE_LENGTH
      ? `${clipped.slice(0, MAX_EVENT_CONSEQUENCE_LENGTH - 1)}…`
      : clipped;
  return { verb, consequence: bounded };
}

export function phraseTurnSilence(
  name: string,
  classified: ClassifiedTurnSilence,
  options: { readonly givingUp?: boolean } = {},
): TurnSilencePhrase {
  const agent = name.trim() || 'The agent';
  switch (classified.kind) {
    case 'wrong-model':
      return capLine(
        agent,
        'could not answer',
        "she's set to a model that isn't available. Pick another in her settings.",
      );
    case 'allowance-spent': {
      const until = classified.allowanceUntil?.trim();
      return capLine(
        agent,
        'could not answer',
        until
          ? `her provider allowance is spent until ${until}. Top up, or move her to another provider.`
          : 'her provider allowance is spent. Top up, or move her to another provider.',
      );
    }
    case 'not-signed-in':
      return capLine(
        agent,
        'could not answer',
        "she isn't signed in to her provider. Run `beeline connect` on her machine.",
      );
    case 'workspace-failure':
      return capLine(
        agent,
        'could not answer',
        `she couldn't get a working copy of ${classified.repo ?? 'the repository'}. Check the repository is reachable.`,
      );
    case 'helper-out-of-date':
      return capLine(
        agent,
        'could not answer',
        'her helper is out of date. Run `beeline start` on her machine.',
      );
    case 'offline':
      return capLine(
        agent,
        'is offline',
        "her helper isn't running. Run `beeline start` on her machine.",
      );
    case 'hiccup': {
      const fault = (classified.fault ?? 'the turn stalled').replace(/\s+/g, ' ').trim();
      const remedy = options.givingUp
        ? 'Stopped restarting after three tries.'
        : 'Restarting her and resending your message.';
      return capLine(agent, 'could not answer', `${fault}. ${remedy}`);
    }
  }
}
