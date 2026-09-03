/**
 * One distilled line for a failed turn receipt. The Room carries the fact
 * ("Candy could not answer · provider error 429"); the full error stays in the
 * daemon log. Never a stack trace, never a credential, at most 200 chars.
 */
export const TURN_FAILURE_REASON_MAX = 200;

/** Keep wire-visible tool detail useful without ever carrying credentials. */
export function redactToolDetail(value: string): string {
  return value
    .replace(
      /\b(["']?)(api[_-]?key|token|secret|password|passwd|authorization|credential|cookie|private[_-]?key)\1\s*[:=]\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,}\]]+)/gi,
      '"$2": "[REDACTED]"',
    )
    .replace(
      /\b(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*=(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\S+)/g,
      (assignment) => `${assignment.slice(0, assignment.indexOf('='))}=[REDACTED]`,
    )
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,})\b/gi, '[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
    .replace(/\b(Bearer\s+)[^\s,]+/gi, '$1[REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[REDACTED]')
    .replace(
      /(--?(?:api[_-]?key|token|secret|password|authorization|credential|cookie)\s+)(?:"[^"]*"|'[^']*'|\S+)/gi,
      '$1[REDACTED]',
    );
}

export function distillTurnFailureReason(error: unknown): string {
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
  const firstLine =
    raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line && !/^at\s/.test(line)) ?? '';
  const stripped = firstLine.replace(/^(?:[A-Za-z]*Error|Error):\s*/, '').replace(/\s+/g, ' ');
  const clean = redactToolDetail(stripped).trim();
  if (!clean) return 'turn failed';
  return clean.length > TURN_FAILURE_REASON_MAX
    ? `${clean.slice(0, TURN_FAILURE_REASON_MAX - 1)}…`
    : clean;
}
