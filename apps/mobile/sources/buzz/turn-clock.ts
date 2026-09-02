/**
 * The thinking line's clock: spinner glyph, per-turn verb, elapsed seconds,
 * and the settled "done" line. Pure functions so the per-second contract is
 * testable without a renderer.
 *
 * Modeled on the Claude Code status line: a spinner frame cycling back and
 * forth, a gerund verb, then "(Ns · thinking)" ticking once per second from
 * the server receipt's own time. On completion the line settles briefly to
 * "<Past> for Ns · done h:MM" before the transcript resumes its silence.
 */

/** Spinner frames, ping-ponged (0→5→0) like the reference animation. */
export const SPINNER_FRAMES = ['\u00b7', '\u2722', '\u2733', '\u2736', '\u273d', '\u273b'] as const;

/** One spinner step, ~8 steps per second. */
export const SPINNER_STEP_MS = 125;

/**
 * The gerund shown while working, and its past tense on the settled line.
 * Picked once per turn (seeded by the turn's identity), never per tick.
 */
export const TURN_VERBS = [
  { gerund: 'Thinking', past: 'Thought' },
  { gerund: 'Working', past: 'Worked' },
  { gerund: 'Pondering', past: 'Pondered' },
  { gerund: 'Brewing', past: 'Brewed' },
  { gerund: 'Mulling', past: 'Mulled' },
] as const;

export type TurnVerb = (typeof TURN_VERBS)[number];

/** Small deterministic string hash (FNV-1a) — enough to spread verbs across turns. */
function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * One verb per turn: the same turn always renders the same verb on every
 * tick and on its settled line, and different turns differ.
 */
export function pickTurnVerb(turnKey: string): TurnVerb {
  return TURN_VERBS[hashString(turnKey) % TURN_VERBS.length]!;
}

/** Ping-pong the frame index: 0..n-1 then back down, never jumping. */
export function spinnerFrameIndexAt(elapsedMs: number): number {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return 0;
  const count = SPINNER_FRAMES.length;
  const cycle = count * 2 - 2;
  const step = Math.floor(elapsedMs / SPINNER_STEP_MS) % cycle;
  return step < count ? step : cycle - step;
}

export function spinnerFrameAt(elapsedMs: number): string {
  return SPINNER_FRAMES[spinnerFrameIndexAt(elapsedMs)]!;
}

/** Whole seconds elapsed since the receipt's server time, floored at zero. */
export function elapsedSeconds(startedAtMs: number, nowMs: number): number {
  return Math.max(0, Math.floor((nowMs - startedAtMs) / 1_000));
}

/** Local wall clock as the settled line's "done h:MM" stamp. */
export function formatDoneTime(whenMs: number): string {
  return new Date(whenMs)
    .toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    .toLowerCase();
}

/** `<Past> for Ns · done h:MM` — the static summary a finished turn leaves. */
export function formatSettledLine(verb: TurnVerb, startedAtMs: number, endedAtMs: number): string {
  const seconds = elapsedSeconds(startedAtMs, endedAtMs);
  return `${verb.past} for ${seconds}s \u00b7 done ${formatDoneTime(endedAtMs)}`;
}
