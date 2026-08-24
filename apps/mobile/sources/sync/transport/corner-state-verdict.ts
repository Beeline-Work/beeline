/**
 * Mobile's only corner-state projection. It is intentionally a dumb lookup
 * over the canonical daemon record plus relay existence. Transcript cards,
 * drafts, turn events, and presence never enter this function.
 */
import { isCornerStateRecordFresh, type CornerStateRecord } from '@beeline/buzz-client';
import type { CornerStatus } from '@/buzz/corners';

export type CornerVerdictSource = 'record' | 'existence' | 'absent';

export type CornerVerdict = {
  status: CornerStatus | null;
  machineState?: CornerStateRecord['state'];
  machineReason?: CornerStateRecord['reason'];
  stateAt?: number;
  awaitingReply?: boolean;
  source: CornerVerdictSource;
};

export function cornerVerdictFromRecord(
  record: CornerStateRecord,
  now = Date.now(),
): CornerVerdict {
  switch (record.state) {
    case 'open':
    case 'idle':
      return {
        status: null,
        machineState: record.state,
        ...(record.reason ? { machineReason: record.reason } : {}),
        stateAt: record.at,
        source: 'record',
      };
    case 'working':
      return {
        status: isCornerStateRecordFresh(record, now) ? 'live' : null,
        machineState: record.state,
        ...(record.reason ? { machineReason: record.reason } : {}),
        stateAt: record.at,
        source: 'record',
      };
    case 'waiting':
      return {
        status:
          record.reason === 'review'
            ? 'open'
            : record.reason === 'failure'
              ? 'failed'
              : 'needs-attention',
        machineState: record.state,
        ...(record.reason ? { machineReason: record.reason } : {}),
        stateAt: record.at,
        ...(record.reason === 'question' ? { awaitingReply: true } : {}),
        source: 'record',
      };
    case 'concluded':
      return {
        status: 'merged',
        machineState: record.state,
        ...(record.reason ? { machineReason: record.reason } : {}),
        stateAt: record.at,
        source: 'record',
      };
    case 'closed':
      return {
        status: 'archived',
        machineState: record.state,
        ...(record.reason ? { machineReason: record.reason } : {}),
        stateAt: record.at,
        source: 'record',
      };
  }
}

export function resolveCornerVerdict(input: {
  stateRecord?: CornerStateRecord;
  channelExists: boolean;
  parentRoomLive: boolean;
  now?: number;
}): CornerVerdict {
  // Relay existence is a hard upper bound on any record. This is the UI half
  // of ghost immunity: even a stale canonical WORKING record cannot resurrect
  // a child that is missing, archived, or attached to a dead parent.
  if (!input.channelExists || !input.parentRoomLive) {
    return {
      status: 'archived',
      ...(input.stateRecord
        ? { machineState: 'closed' as const, stateAt: input.stateRecord.at }
        : {}),
      source: 'existence',
    };
  }
  if (!input.stateRecord) return { status: null, source: 'absent' };
  return cornerVerdictFromRecord(input.stateRecord, input.now);
}
