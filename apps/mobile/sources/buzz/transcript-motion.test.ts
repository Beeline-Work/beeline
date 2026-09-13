import { describe, expect, it } from 'vitest';
import {
  EMPTY_TRANSCRIPT_ARRIVAL_STATE,
  TRANSCRIPT_SETTLE_MS,
  observeTranscriptArrivals,
  transcriptSettleDecision,
  transcriptSteadyColors,
} from './transcript-motion';

describe('transcript brass-glow decisions', () => {
  it('seeds the first hydrated render without calling history new', () => {
    const observed = observeTranscriptArrivals(EMPTY_TRANSCRIPT_ARRIVAL_STATE, {
      surfaceId: 'room-1',
      hydrated: true,
      ids: ['old-card'],
    });
    expect([...observed.arrivingIds]).toEqual([]);
    expect(observed.state.seenIds.has('old-card')).toBe(true);
  });

  it('marks a later live append exactly once', () => {
    const initial = observeTranscriptArrivals(EMPTY_TRANSCRIPT_ARRIVAL_STATE, {
      surfaceId: 'room-1',
      hydrated: true,
      ids: ['old-card'],
    });
    const appended = observeTranscriptArrivals(initial.state, {
      surfaceId: 'room-1',
      hydrated: true,
      ids: ['old-card', 'new-card'],
    });
    expect([...appended.arrivingIds]).toEqual(['new-card']);
    expect([
      ...observeTranscriptArrivals(appended.state, {
        surfaceId: 'room-1',
        hydrated: true,
        ids: ['old-card', 'new-card'],
      }).arrivingIds,
    ]).toEqual([]);
  });

  it('collapses a same-card burst into the settle already in flight', () => {
    expect(transcriptSettleDecision(null, 1_000, false)).toEqual({
      animate: true,
      startsNewSettle: true,
      durationMs: TRANSCRIPT_SETTLE_MS,
    });
    expect(transcriptSettleDecision(1_000, 1_600, false)).toEqual({
      animate: true,
      startsNewSettle: false,
      durationMs: 1_200,
    });
  });

  it('renders every change settled when reduced motion is enabled', () => {
    expect(transcriptSettleDecision(null, 1_000, true)).toEqual({
      animate: false,
      startsNewSettle: false,
      durationMs: 0,
    });
  });

  it('settles onto the existing theme tokens', () => {
    const palette = {
      textPrimary: '#primary',
      textSecondary: '#secondary',
      quiet: '#quiet',
      ghost: '#ghost',
      waiting: '#accent',
      failed: '#failed',
    };
    expect(transcriptSteadyColors(palette)).toEqual({
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
    });
  });
});
