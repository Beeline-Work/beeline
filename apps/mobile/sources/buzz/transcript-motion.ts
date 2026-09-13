export const TRANSCRIPT_BRASS = '#b08a4a';
export const TRANSCRIPT_SETTLE_MS = 1_800;
export const TRANSCRIPT_BURST_MS = 1_000;

export type TranscriptArrivalState = {
  surfaceId: string | null;
  initialized: boolean;
  seenIds: ReadonlySet<string>;
};

export type TranscriptArrivalObservation = {
  state: TranscriptArrivalState;
  arrivingIds: ReadonlySet<string>;
};

export const EMPTY_TRANSCRIPT_ARRIVAL_STATE: TranscriptArrivalState = {
  surfaceId: null,
  initialized: false,
  seenIds: new Set(),
};

/**
 * Compare transcript ids at the Room boundary. The first hydrated frame is
 * history and only seeds the registry; later ids are genuine live arrivals.
 */
export function observeTranscriptArrivals(
  previous: TranscriptArrivalState,
  input: { surfaceId: string; hydrated: boolean; ids: readonly string[] },
): TranscriptArrivalObservation {
  if (previous.surfaceId !== input.surfaceId) {
    if (!input.hydrated) {
      return {
        state: { surfaceId: input.surfaceId, initialized: false, seenIds: new Set() },
        arrivingIds: new Set(),
      };
    }
    return {
      state: { surfaceId: input.surfaceId, initialized: true, seenIds: new Set(input.ids) },
      arrivingIds: new Set(),
    };
  }
  if (!input.hydrated) return { state: previous, arrivingIds: new Set() };
  if (!previous.initialized) {
    return {
      state: { surfaceId: input.surfaceId, initialized: true, seenIds: new Set(input.ids) },
      arrivingIds: new Set(),
    };
  }

  const arrivingIds = new Set(input.ids.filter((id) => !previous.seenIds.has(id)));
  return {
    state: {
      surfaceId: input.surfaceId,
      initialized: true,
      seenIds: new Set([...previous.seenIds, ...input.ids]),
    },
    arrivingIds,
  };
}

export type TranscriptSettleDecision = {
  animate: boolean;
  startsNewSettle: boolean;
  durationMs: number;
};

/** Events inside one second share the settle already in flight instead of restarting it. */
export function transcriptSettleDecision(
  lastStartedAt: number | null,
  now: number,
  reducedMotion: boolean,
): TranscriptSettleDecision {
  if (reducedMotion) return { animate: false, startsNewSettle: false, durationMs: 0 };
  if (lastStartedAt === null || now - lastStartedAt >= TRANSCRIPT_BURST_MS) {
    return { animate: true, startsNewSettle: true, durationMs: TRANSCRIPT_SETTLE_MS };
  }
  return {
    animate: true,
    startsNewSettle: false,
    durationMs: Math.max(1, TRANSCRIPT_SETTLE_MS - (now - lastStartedAt)),
  };
}

/** Named steady endpoints keep the animation tied to the existing theme roles. */
export function transcriptSteadyColors(palette: {
  textPrimary: string;
  textSecondary: string;
  quiet: string;
  ghost: string;
  waiting: string;
  failed: string;
}) {
  return {
    title: palette.textPrimary,
    body: palette.textSecondary,
    quiet: palette.quiet,
    rowTitle: palette.textPrimary,
    rowKind: palette.ghost,
    rowState: {
      settled: palette.quiet,
      waiting: palette.waiting,
      failed: palette.failed,
    },
  } as const;
}
