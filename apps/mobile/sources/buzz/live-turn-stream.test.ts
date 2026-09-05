import { describe, expect, it } from 'vitest';
import type { LiveOverlay, RoomViewAgentTurn } from '@beeline/buzz-client';
import { applyLiveOverlay } from '@beeline/buzz-client';
import type { ChatDisplayMessage } from './room-view-presentation';
import { mergeDisplayPages } from './room-view-presentation';
import { liveDraftMessages, projectActiveTurnStream } from './live-turn-stream';
import { joinedTurnRowId, liveDraftRowId } from './draft-settle';

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
      message(liveDraftRowId(AGENT, 'request-1'), 104, {
        isAgentActivity: true,
        isAgentLiveTurn: true,
        isAgentDraft: true,
        agentMessageDraft: 'The answer is streaming.',
      }),
    ];

    const projected = projectActiveTurnStream(rows, [WORKING], false);

    expect(projected.map((row) => row.id)).toEqual([
      'old-activity',
      joinedTurnRowId(AGENT, 'request-1'),
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

    expect(projectActiveTurnStream([thought], [WORKING], false)).toEqual([]);
  });

  it('does not consume another agent or a draft for another request', () => {
    const other = message('other-agent-tool', 101, {
      pubkey: OTHER_AGENT,
      isAgentActivity: true,
      activity: [{ kind: 'tool', title: 'other work' }],
    });
    const otherDraft = message(liveDraftRowId(AGENT, 'request-0'), 102, {
      isAgentActivity: true,
      isAgentLiveTurn: true,
      agentMessageDraft: 'An older answer.',
    });
    const active = message('active-tool', 103, {
      isAgentActivity: true,
      activity: [{ kind: 'tool', title: 'current work' }],
    });

    const projected = projectActiveTurnStream([other, otherDraft, active], [WORKING], false);

    expect(projected.map((row) => row.id)).toEqual([
      'other-agent-tool',
      liveDraftRowId(AGENT, 'request-0'),
      joinedTurnRowId(AGENT, 'request-1'),
    ]);
  });

  it('leaves a failed turn holding its streamed words and the failure line (C98)', () => {
    // Nothing the reader was mid-way through evaporates: the retracted draft
    // keeps its last text and the server-phrased failure line stands with it.
    const rows = [
      message(liveDraftRowId(AGENT, 'request-1'), 105, {
        isAgentActivity: true,
        isAgentDraft: true,
        agentMessageDraft: 'The answer is',
        text: 'The answer is',
      }),
      message('turn-failed', 106, {
        isSystemNotice: true,
        text: 'Clara could not answer · provider error 402',
      }),
    ];
    const failed = { ...WORKING, status: 'failed' as const };

    expect(projectActiveTurnStream(rows, [failed], false)).toBe(rows);
  });

  it('returns settled and archived transcripts verbatim', () => {
    const rows = [message('fact', 101, { durableFact: { kind: 'action' } })];
    const complete = { ...WORKING, status: 'complete' as const };

    expect(projectActiveTurnStream(rows, [complete], false)).toBe(rows);
    expect(projectActiveTurnStream(rows, [WORKING], true)).toBe(rows);
  });
});

/**
 * Two agents doing fan-out research in one Room, both streaming at once.
 *
 * Reported on v0.0.47: "they overwrite each other — fuckface writing chunking
 * output overwrote all of goosy's output". One human message addressed both
 * agents, so both turns carry that message's id as their request id, and the
 * draft row was named `live-turn:<request>` alone: `mergeDisplayPages` keys
 * the transcript by row id, so the second agent's draft replaced the first
 * agent's outright and one whole answer disappeared.
 */
describe('two agents streaming at once', () => {
  const REQUEST = 'c'.repeat(64);

  function draft(agentPubkey: string, text: string, createdAt: number): LiveOverlay {
    return {
      kind: 'draft',
      key: `draft:${agentPubkey}:${REQUEST}`,
      stableId: `live-turn:${agentPubkey}:${REQUEST}`,
      agentPubkey,
      requestId: REQUEST,
      text,
      closed: false,
      createdAt,
    };
  }

  function stream(...updates: readonly LiveOverlay[]): readonly LiveOverlay[] {
    return updates.reduce<readonly LiveOverlay[]>(
      (overlays, update) => applyLiveOverlay(overlays, update),
      [],
    );
  }

  it('gives each agent its own row, at its own turn start, edited in place', () => {
    // Goosy started first, so goosy holds n-1 and the other agent holds n —
    // and the wire stamps that walk forward with every chunk never move them.
    const overlays = stream(
      draft(AGENT, 'goosy one', 100),
      draft(OTHER_AGENT, 'other one', 101),
      draft(AGENT, 'goosy one two', 102),
      draft(OTHER_AGENT, 'other one two', 103),
      draft(AGENT, 'goosy one two three', 104),
    );

    const rows = mergeDisplayPages([], liveDraftMessages(overlays, []));

    expect(rows.map((row) => [row.id, row.pubkey, row.agentMessageDraft])).toEqual([
      [liveDraftRowId(AGENT, REQUEST), AGENT, 'goosy one two three'],
      [liveDraftRowId(OTHER_AGENT, REQUEST), OTHER_AGENT, 'other one two'],
    ]);
    expect(rows.map((row) => row.timestamp)).toEqual([100, 101]);
  });

  it('projects both live turns, each into its own lane, in turn-start order', () => {
    const overlays = stream(
      draft(AGENT, 'goosy is writing', 100),
      draft(OTHER_AGENT, 'the other is writing', 101),
      draft(AGENT, 'goosy is still writing', 140),
    );
    const turns: RoomViewAgentTurn[] = [
      // Heartbeat receipts have walked both stamps well past the turn starts.
      { requestId: REQUEST, agentPubkey: AGENT, status: 'working', createdAt: 150 },
      { requestId: REQUEST, agentPubkey: OTHER_AGENT, status: 'working', createdAt: 151 },
    ];

    const projected = projectActiveTurnStream(
      mergeDisplayPages([], liveDraftMessages(overlays, [])),
      turns,
      false,
    );

    expect(projected.map((row) => [row.id, row.agentMessageDraft])).toEqual([
      [joinedTurnRowId(AGENT, REQUEST), 'goosy is still writing'],
      [joinedTurnRowId(OTHER_AGENT, REQUEST), 'the other is writing'],
    ]);
    expect(projected.map((row) => row.timestamp)).toEqual([100, 101]);
  });

  it('settles one agent in place and leaves the other still streaming', () => {
    // The durable answer carries the request id, so `visibleLiveOverlays`
    // dissolves ONLY that author's draft (C98). The other row is untouched.
    const overlays = stream(draft(AGENT, 'goosy is writing', 100), draft(OTHER_AGENT, 'other', 101));
    const durable = [
      {
        id: 'durable-1',
        text: 'goosy is done',
        createdAt: 160,
        author: { pubkey: AGENT, kind: 'agent' as const, name: 'Goosy' },
        presentation: 'message' as const,
        requestId: REQUEST,
      },
    ];

    const rows = liveDraftMessages(overlays, durable);

    expect(rows.map((row) => row.id)).toEqual([liveDraftRowId(OTHER_AGENT, REQUEST)]);
  });
});
