import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CornerStateRecord } from '@beeline/buzz-client';
import {
  cornerStateFallbackCount,
  cornerVerdictFromRecord,
  resetCornerStateFallbackTelemetry,
  resolveCornerVerdict,
} from './corner-state-verdict';

const record = (
  state: CornerStateRecord['state'],
  reason?: CornerStateRecord['reason'],
  at = 100,
): CornerStateRecord => ({ cornerId: 'corner-1', state, ...(reason ? { reason } : {}), at });

describe('daemon-authoritative corner verdict', () => {
  beforeEach(() => resetCornerStateFallbackTelemetry());

  it('maps each fresh daemon state without consulting history', () => {
    expect(cornerVerdictFromRecord(record('working'))).toEqual({
      status: 'live',
      source: 'record',
    });
    expect(cornerVerdictFromRecord(record('idle'))).toEqual({
      status: null,
      source: 'record',
    });
    expect(cornerVerdictFromRecord(record('waiting-on-human', 'review'))).toEqual({
      status: 'open',
      source: 'record',
    });
    expect(cornerVerdictFromRecord(record('waiting-on-human', 'question'))).toEqual({
      status: 'needs-attention',
      awaitingReply: true,
      source: 'record',
    });
    expect(cornerVerdictFromRecord(record('waiting-on-human', 'failure'))).toEqual({
      status: 'failed',
      source: 'record',
    });
  });

  it('demotes an offline question but keeps artifact-backed waits actionable', () => {
    expect(cornerVerdictFromRecord(record('waiting-on-human', 'question'), true)).toEqual({
      status: null,
      agentOffline: true,
      source: 'record',
    });
    expect(cornerVerdictFromRecord(record('waiting-on-human', 'failure'), true)).toEqual({
      status: 'failed',
      source: 'record',
    });
    expect(cornerVerdictFromRecord(record('waiting-on-human', 'review'), true)).toEqual({
      status: 'open',
      source: 'record',
    });
  });

  it('uses a record whose at is at least the newest transcript timestamp', () => {
    const verdict = resolveCornerVerdict({
      cornerId: 'corner-1',
      stateRecord: record('working', undefined, 100),
      newestTranscriptAt: 100,
      facts: [{ createdAt: 200, rawStatus: 'failed' }],
      merged: false,
      archived: false,
    });
    expect(verdict).toEqual({ status: 'live', source: 'record' });
    expect(cornerStateFallbackCount()).toBe(0);
  });

  it('falls back for absent and stale records, counting only those fallbacks', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const base = {
      cornerId: 'corner-1',
      newestTranscriptAt: 100,
      facts: [{ createdAt: 100, rawStatus: 'working' }],
      merged: false,
      archived: false,
      now: 1_000,
    } as const;
    expect(resolveCornerVerdict(base).source).toBe('fallback');
    expect(
      resolveCornerVerdict({ ...base, stateRecord: record('idle', undefined, 99), now: 61_001 })
        .source,
    ).toBe('fallback');
    expect(cornerStateFallbackCount()).toBe(2);
    expect(log).toHaveBeenCalledTimes(2);
    resolveCornerVerdict({ ...base, stateRecord: record('idle', undefined, 100) });
    expect(cornerStateFallbackCount()).toBe(2);
    log.mockRestore();
  });

  it('lets immutable terminal truth win without recording a migration fallback', () => {
    expect(
      resolveCornerVerdict({
        cornerId: 'corner-1',
        stateRecord: record('working'),
        newestTranscriptAt: 100,
        facts: [],
        merged: true,
        archived: false,
      }).status,
    ).toBe('merged');
    expect(cornerStateFallbackCount()).toBe(0);
  });
});
