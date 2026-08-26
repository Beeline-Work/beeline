/**
 * Cold-open instrumentation for the chat transcript's first paint.
 *
 * The corner-open fast path (`local-cache-sync.ts` →
 * `BuzzRigTransport.readModelTail`) puts exactly ONE bounded relay read on the
 * first-paint critical path; authority, sibling corner states, projections,
 * membership, and presence hydrate later through independent deferred steps.
 * These samples keep the two regimes separately measurable so a latency
 * regression identifies WHICH read regressed: a growing `tailMs` is the
 * critical-path read itself, while `deferredMs`/`deferredError` growth must
 * never delay, blank, or time out the transcript.
 *
 * In-memory only (last `MAX_COLD_OPEN_SAMPLES` opens), never persisted, and
 * dependency-free so its tests need no React Native mocks.
 */

export type ColdOpenSample = {
  channelId: string;
  startedAt: number;
  /** Critical-path bounded tail read: elapsed ms and event count. */
  tailMs?: number;
  tailEventCount?: number;
  /** Set when the tail read exceeded the cold-open deadline. */
  tailTimedOutAfterMs?: number;
  /** Non-timeout failure of the tail read (this one IS user-visible). */
  tailError?: string;
  /** Deferred full reconciliation: elapsed ms when it settled successfully. */
  deferredMs?: number;
  /** Deferred-step failure — recorded but never allowed to touch the paint. */
  deferredError?: string;
};

export const MAX_COLD_OPEN_SAMPLES = 20;

const samples: ColdOpenSample[] = [];

export function coldOpenSamples(): readonly ColdOpenSample[] {
  return samples;
}

export function resetColdOpenSamples(): void {
  samples.length = 0;
}

export type ColdOpenRecorder = {
  /** When this open began (ms epoch) — for callers computing elapsed time. */
  readonly startedAt: number;
  /** The critical-path tail read settled within the deadline. */
  tailSettled(elapsedMs: number, eventCount: number): void;
  /** The critical-path tail read hit the deadline (user-visible timeout). */
  tailTimedOut(deadlineMs: number): void;
  /** The critical-path tail read failed for another reason. */
  tailFailed(error: unknown): void;
  /** The deferred full reconciliation settled (success or not). */
  deferredSettled(elapsedMs: number | undefined, error: unknown | undefined): void;
};

export function beginColdOpenSample(channelId: string): ColdOpenRecorder {
  const sample: ColdOpenSample = { channelId, startedAt: Date.now() };
  samples.push(sample);
  if (samples.length > MAX_COLD_OPEN_SAMPLES) samples.shift();
  return {
    startedAt: sample.startedAt,
    tailSettled: (tailMs, tailEventCount) => {
      sample.tailMs = tailMs;
      sample.tailEventCount = tailEventCount;
    },
    tailTimedOut: (tailTimedOutAfterMs) => {
      sample.tailTimedOutAfterMs = tailTimedOutAfterMs;
    },
    tailFailed: (error) => {
      sample.tailError = String(error);
    },
    deferredSettled: (deferredMs, error) => {
      if (error !== undefined) sample.deferredError = String(error);
      else if (deferredMs !== undefined) sample.deferredMs = deferredMs;
    },
  };
}
