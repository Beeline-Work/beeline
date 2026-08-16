import { describe, expect, it } from 'vitest';
import { cornerSessionState, latestCornerTurnSummary } from './corner-session';

describe('corner session presentation', () => {
  it('uses the corner turn lifecycle, not presence, for working, idle, and done', () => {
    expect(cornerSessionState([])).toBe('idle');
    expect(
      cornerSessionState([
        {
          id: 'working',
          text: 'Agent is thinking',
          isUser: false,
          timestamp: 1,
          agentTurn: { requestId: 'turn', agentPubkey: 'agent', status: 'working' },
        },
      ]),
    ).toBe('working');
    expect(
      cornerSessionState([
        {
          id: 'complete',
          text: 'Done',
          isUser: false,
          timestamp: 2,
          agentTurn: { requestId: 'turn', agentPubkey: 'agent', status: 'complete' },
        },
      ]),
    ).toBe('done');
  });

  it('uses the durable agent reply as the turn summary', () => {
    expect(
      latestCornerTurnSummary([
        { id: 'steer', text: 'Please rename the Room', isUser: true, timestamp: 1 },
        {
          id: 'summary',
          text: 'Renamed the Room and updated its tests.',
          isUser: false,
          timestamp: 2,
        },
      ]),
    ).toBe('Renamed the Room and updated its tests.');
  });
});
