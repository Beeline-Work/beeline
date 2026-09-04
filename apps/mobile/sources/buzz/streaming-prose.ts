/**
 * The provisional lane's arithmetic (C98).
 *
 * While an agent writes, the phone paints the accumulating draft. The text is
 * NOT finished, so it must not read as finished: it is set in the provisional
 * face and tone, and the characters that just arrived fade up out of the
 * ground rather than the whole block re-appearing.
 *
 * Everything here is pure so the honesty rules are testable without a
 * renderer: a tail is only ever text the model has ALREADY produced, and the
 * fade is driven by arrival — never by a clock that invents characters.
 */

export type StreamState = {
  /** Every character the model has produced so far. Never more than that. */
  readonly text: string;
  /** How much of it has finished fading in. */
  readonly settled: number;
  /** 0 → the pending tail is still the ground colour; 1 → fully arrived. */
  readonly progress: number;
};

export function openStream(text: string, animate: boolean): StreamState {
  return { text, settled: animate ? 0 : text.length, progress: animate ? 0 : 1 };
}

/**
 * Fold the next streamed value into the current one.
 *
 * An ordinary delta EXTENDS the text: everything already shown keeps its
 * place and only the appended characters are pending, so the reader never
 * sees settled prose restate itself. A value that is not an extension is a
 * rewrite — the harness replaced what it had written — and a rewrite settles
 * whole, because fading in text the reader has already read would be a lie
 * about what just arrived.
 */
export function advanceStream(current: StreamState, next: string, animate: boolean): StreamState {
  if (next === current.text) return current;
  if (!animate) return { text: next, settled: next.length, progress: 1 };
  if (!next.startsWith(current.text)) return { text: next, settled: next.length, progress: 1 };
  // A window already running keeps its progress; the new characters join it.
  // A settled lane opens a new window at the ground colour.
  return { text: next, settled: current.settled, progress: current.progress >= 1 ? 0 : current.progress };
}

/** Characters that have arrived but have not finished fading in. */
export function pendingTailLength(state: StreamState): number {
  return Math.max(0, state.text.length - state.settled);
}

function channel(hex: string, at: number): number {
  return Number.parseInt(hex.slice(at, at + 2), 16);
}

/**
 * Mix two `#rrggbb` colours. The tail fades by walking its colour up from the
 * transcript ground to the provisional tone — a real fade, expressed as text
 * colour, because a nested `Text` carries colour on every platform and does
 * not reliably carry opacity.
 */
export function mixHex(from: string, to: string, amount: number): string {
  const t = Math.min(1, Math.max(0, amount));
  const step = (at: number) =>
    Math.round(channel(from, at) + (channel(to, at) - channel(from, at)) * t)
      .toString(16)
      .padStart(2, '0');
  return `#${step(1)}${step(3)}${step(5)}`;
}
