/**
 * The thinking line's clock: spinner glyph, per-turn verb, elapsed duration,
 * and the settled "done" line. Pure functions so the per-second contract is
 * testable without a renderer.
 *
 * Modeled on the Claude Code status line: a spinner frame cycling back and
 * forth, a gerund verb, then elapsed time ticking once per second from
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

/** The live counter phase; only the exceptional stopping state needs a label. */
export type WorkingPhase = 'thinking' | 'stopping';

function formatElapsedDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

/** `Ns` below a minute, then `Nm Ns`; append stopping when requested. */
export function formatWorkingCounter(
  startedAtMs: number,
  nowMs: number,
  phase: WorkingPhase = 'thinking',
): string {
  const elapsed = elapsedSeconds(startedAtMs, nowMs);
  const duration = formatElapsedDuration(elapsed);
  return phase === 'stopping' ? `${duration} \u00b7 stopping` : duration;
}

/** Local wall clock as the settled line's "done h:MM" stamp. */
export function formatDoneTime(whenMs: number): string {
  return new Date(whenMs)
    .toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    .toLowerCase();
}

/** `<Past> for Ns · done h:MM` — the static summary a finished turn leaves. */
export function formatSettledLine(verb: TurnVerb, startedAtMs: number, endedAtMs: number): string {
  const duration = formatElapsedDuration(elapsedSeconds(startedAtMs, endedAtMs));
  return `${verb.past} for ${duration} \u00b7 done ${formatDoneTime(endedAtMs)}`;
}

/**
 * `<Past> for Ns · stopped h:MM` — the summary a turn the requester stopped
 * leaves instead.
 *
 * Same shape, one different word, and the word is the whole point: a stopped
 * turn is not `done`. The seconds it did run are still true and still shown —
 * the person spent that wait — but nothing here may imply an answer arrived.
 * Who stopped it is inscribed in the Room by the server; this line is only the
 * status line's own last word before it clears.
 */
export function formatStoppedLine(verb: TurnVerb, startedAtMs: number, endedAtMs: number): string {
  const duration = formatElapsedDuration(elapsedSeconds(startedAtMs, endedAtMs));
  return `${verb.past} for ${duration} \u00b7 stopped ${formatDoneTime(endedAtMs)}`;
}
