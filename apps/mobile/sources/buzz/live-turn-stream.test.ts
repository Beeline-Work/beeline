import { describe, expect, it } from 'vitest';
import type { RoomViewAgentTurn } from '@beeline/buzz-client';
import type { ChatDisplayMessage } from './room-view-presentation';
import { projectActiveTurnStream } from './live-turn-stream';

const AGENT = 'a'.repeat(64);
const OTHER_AGENT = 'b'.repeat(64);

function message(
  id: string,
  timestamp: number,
  overrides: Partial<ChatDisplayMessage> = {},
): ChatDisplayMessage {
  return { id, timestamp, text: '', isUser: false, pubkey: AGENT, ...overrides };
}

const WORKING: RoomViewAgentTurn = {
  requestId: 'request-1',
  agentPubkey: AGENT,
  status: 'working',
  createdAt: 100,
};

describe('active turn stream projection', () => {
  it('joins indexed activity with the matching request draft and consumes private thought', () => {
    const rows = [
      message('old-activity', 90, {
        isAgentActivity: true,
        activity: [{ kind: 'tool', title: 'old read', toolKind: 'read' }],
      }),
      message('active-tool-1', 101, {
        isAgentActivity: true,
        durableFact: { kind: 'action' },
        activity: [{ kind: 'tool', title: 'edited Ledger.tsx', toolKind: 'edit' }],
      }),
      message('thought:agent:session', 102, {
        isAgentActivity: true,
        isAgentLiveTurn: true,
        agentThought: 'PRIVATE THOUGHT MUST NOT RENDER',
      }),
      message('active-tool-2', 103, {
        isAgentActivity: true,
        activity: [
          {
            kind: 'summary',
            title: 'read receipts',
            observed: [{ verb: 'read', target: 'Ledger.tsx', result: 'found live row' }],
          },
        ],
      }),
      message('live-turn:request-1', 104, {
        isAgentActivity: true,
        isAgentLiveTurn: true,
        isAgentDraft: true,
        agentMessageDraft: 'The answer is streaming.',
      }),
    ];

    const projected = projectActiveTurnStream(rows, WORKING, false);

    expect(projected.map((row) => row.id)).toEqual([
      'old-activity',
      'active-turn-stream:request-1',
    ]);
    expect(projected[1]).toMatchObject({
      pubkey: AGENT,
      isAgentActivity: true,
      isAgentLiveTurn: true,
      agentMessageDraft: 'The answer is streaming.',
      activity: [{ title: 'edited Ledger.tsx' }, { title: 'read receipts' }],
    });
    expect(projected[1]).not.toHaveProperty('agentThought');
    expect(projected[1]).not.toHaveProperty('durableFact');
  });

  it('removes a thought-only live row instead of projecting it into the transcript', () => {
    const thought = message('thought:agent:session', 102, {
      isAgentActivity: true,
      isAgentLiveTurn: true,
      agentThought: 'PRIVATE THOUGHT MUST NOT RENDER',
    });

    expect(projectActiveTurnStream([thought], WORKING, false)).toEqual([]);
  });

  it('does not consume another agent or a draft for another request', () => {
    const other = message('other-agent-tool', 101, {
      pubkey: OTHER_AGENT,
      isAgentActivity: true,
      activity: [{ kind: 'tool', title: 'other work' }],
    });
    const otherDraft = message('live-turn:request-0', 102, {
      isAgentActivity: true,
      isAgentLiveTurn: true,
      agentMessageDraft: 'An older answer.',
    });
    const active = message('active-tool', 103, {
      isAgentActivity: true,
      activity: [{ kind: 'tool', title: 'current work' }],
    });

    const projected = projectActiveTurnStream([other, otherDraft, active], WORKING, false);

    expect(projected.map((row) => row.id)).toEqual([
      'other-agent-tool',
      'live-turn:request-0',
      'active-turn-stream:request-1',
    ]);
  });

  it('returns settled and archived transcripts verbatim', () => {
    const rows = [message('fact', 101, { durableFact: { kind: 'action' } })];
    const complete = { ...WORKING, status: 'complete' as const };

    expect(projectActiveTurnStream(rows, complete, false)).toBe(rows);
    expect(projectActiveTurnStream(rows, WORKING, true)).toBe(rows);
  });
});
