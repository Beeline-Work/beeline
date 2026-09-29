import timeline from './fullTimeline.json';

// Same API as timing.ts, but for the whole 2:50 song (t = 0 at the start of the track).

export const FPS = 60;
export const DURATION = timeline.duration;
export const BEATS: number[] = timeline.beats;
export const BEAT = 60 / timeline.bpm;
export const SEC = timeline.sections;

export type Word = {text: string; start: number; end: number};
export const WORDS: Word[] = timeline.words;

export function beatIndex(t: number): number {
  let lo = 0;
  let hi = BEATS.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (BEATS[mid] <= t) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

const dropBeat = BEATS.reduce((best, b, i) => (Math.abs(b - (SEC.drop + 0.1)) < Math.abs(BEATS[best] - (SEC.drop + 0.1)) ? i : best), 0);
export const isDownbeat = (i: number) => i >= 0 && (((i - dropBeat) % 4) + 4) % 4 === 0;

export function beatPulse(t: number, decay = 0.16): number {
  const i = beatIndex(t);
  return i < 0 ? 0 : Math.exp(-(t - BEATS[i]) / decay);
}

export function downbeatPulse(t: number, decay = 0.28): number {
  let i = beatIndex(t);
  while (i >= 0 && !isDownbeat(i)) i--;
  return i < 0 ? 0 : Math.exp(-(t - BEATS[i]) / decay);
}

export function onBeat(t: number): number {
  return BEATS.reduce((best, b) => (Math.abs(b - t) < Math.abs(best - t) ? b : best), BEATS[0]);
}

export function beatsIn(a: number, b: number): number[] {
  return BEATS.filter((x) => x >= a && x < b);
}

// First word with this text at or after `from`.
export function word(text: string, from: number): number {
  const w = WORDS.find((x) => x.text === text && x.start >= from - 0.01);
  if (!w) throw new Error(`no word ${text} after ${from}`);
  return w.start;
}

export function wordAt(t: number, from = 0, to = Infinity): {word: Word; index: number} | null {
  let found = -1;
  for (let i = 0; i < WORDS.length; i++) {
    const w = WORDS[i];
    if (w.start >= from && w.start < to && w.start <= t) found = i;
  }
  if (found < 0) return null;
  const w = WORDS[found];
  const next = WORDS[found + 1];
  const holdUntil = Math.min(next ? next.start : Infinity, w.end + 0.9, to);
  return t < holdUntil ? {word: w, index: found} : null;
}

export const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
export const easeOut = (x: number) => 1 - Math.pow(1 - clamp01(x), 3);
export const easeInOut = (x: number) => {
  const c = clamp01(x);
  return c < 0.5 ? 4 * c * c * c : 1 - Math.pow(-2 * c + 2, 3) / 2;
};
