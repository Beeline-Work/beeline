import { describe, expect, it } from 'vitest';
import { CORNER_ACTIVITY_FRESHNESS_MS, type CornerStateRecord } from '@beeline/buzz-client';
import { cornerVerdictFromRecord, resolveCornerVerdict } from './corner-state-verdict';

const AT = 1_700_000_000;
const record = (
  state: CornerStateRecord['state'],
  reason?: CornerStateRecord['reason'],
): CornerStateRecord => ({
  cornerId: 'corner-1',
  parentRoomId: 'room-1',
  state,
  ...(reason ? { reason } : {}),
  at: AT,
});

describe('canonical corner verdict', () => {
  it.each([
    ['open', undefined, null],
    ['working', undefined, 'live'],
    ['waiting', 'review', 'open'],
    ['waiting', 'question', 'needs-attention'],
    ['waiting', 'failure', 'failed'],
    ['idle', undefined, null],
    ['concluded', undefined, 'merged'],
    ['closed', undefined, 'archived'],
  ] as const)('maps %s/%s without consulting transcript history', (state, reason, status) => {
    expect(cornerVerdictFromRecord(record(state, reason), AT * 1_000)).toMatchObject({
      status,
      machineState: state,
      source: 'record',
    });
  });

  it('expires a working lease after the 90-second horizon', () => {
    expect(
      cornerVerdictFromRecord(record('working'), AT * 1_000 + CORNER_ACTIVITY_FRESHNESS_MS),
    ).toMatchObject({ status: 'live' });
    expect(
      cornerVerdictFromRecord(record('working'), AT * 1_000 + CORNER_ACTIVITY_FRESHNESS_MS + 1),
    ).toMatchObject({ status: null, machineState: 'working' });
  });

  it.each([
    { channelExists: false, parentRoomLive: true },
    { channelExists: true, parentRoomLive: false },
  ])('treats nonexistence as closed even over fresh working state: %o', (existence) => {
    expect(
      resolveCornerVerdict({
        ...existence,
        stateRecord: record('working'),
        now: AT * 1_000,
      }),
    ).toMatchObject({ status: 'archived', machineState: 'closed', source: 'existence' });
  });

  it('renders no lifecycle when no canonical record exists', () => {
    expect(resolveCornerVerdict({ channelExists: true, parentRoomLive: true })).toEqual({
      status: null,
      source: 'absent',
    });
  });
});
