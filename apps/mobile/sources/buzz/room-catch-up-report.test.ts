import { describe, expect, it } from 'vitest';
import type { ChatDisplayMessage } from './room-view-presentation';
import { buildCatchUpReport, catchUpClock } from './room-catch-up-report';

const VIEWER = 'pk-viewer';
const AT_0804 = new Date(2026, 8, 22, 8, 4).getTime();

function at(minutesAfterStart: number): number {
  return AT_0804 + minutesAfterStart * 60_000;
}

function said(id: string, name: string, minutes: number, text = id): ChatDisplayMessage {
  return {
    id,
    text,
    isUser: false,
    timestamp: at(minutes),
    authorIdentity: { pubkey: `pk-${name}`, kind: 'agent', name },
  };
}

const identity = (name: string) => ({ pubkey: `pk-${name}`, kind: 'agent' as const, name });

describe('the catch-up report', () => {
  it('CHEV-04: states the range by count and clock, boundary through newest', () => {
    const messages = [
      said('read-0', 'Sol', 0),
      said('new-0', 'Sol', 10),
      { ...said('new-1', 'Nerd', 30), foldedIds: ['new-1', 'new-1-fact'] },
      said('new-2', 'Sol', 102),
    ];
    const report = buildCatchUpReport({
      messages,
      boundaryId: 'new-0',
      newestId: 'new-2',
      viewerPubkey: VIEWER,
    });

    // Four durable ids across three rows: a fold counts every fact it carries.
    expect(report?.range).toEqual({
      boundaryId: 'new-0',
      newestId: 'new-2',
      count: 4,
      startedAt: at(10),
      endedAt: at(102),
    });
    expect(report?.rangeLabel).toBe(`4 msgs · ${catchUpClock(at(10))}–${catchUpClock(at(102))}`);
    // The row before the boundary is read history and is not in the range.
    expect(report?.summary).toContain('4 messages from Sol and Nerd');
  });

  it('CHEV-04: refuses a range it cannot resolve rather than guessing one', () => {
    const messages = [said('only', 'Sol', 0)];
    const base = { messages, viewerPubkey: VIEWER };
    expect(buildCatchUpReport({ ...base, boundaryId: null, newestId: 'only' })).toBeNull();
    expect(buildCatchUpReport({ ...base, boundaryId: 'only', newestId: null })).toBeNull();
    expect(buildCatchUpReport({ ...base, boundaryId: 'gone', newestId: 'only' })).toBeNull();
    // A boundary newer than the newest row is not a range.
    expect(
      buildCatchUpReport({
        messages: [said('a', 'Sol', 0), said('b', 'Sol', 1)],
        boundaryId: 'b',
        newestId: 'a',
        viewerPubkey: VIEWER,
      }),
    ).toBeNull();
  });

  it('CHEV-05: summarises the range from what it demonstrably holds', () => {
    const messages = [
      said('new-0', 'Sol', 0),
      {
        ...said('new-1', 'Nerd', 5),
        choice: {
          choiceId: 'c1',
          mode: 'poll' as const,
          status: 'open' as const,
          agent: identity('Nerd'),
          prompt: 'Ship Friday?',
          options: [],
          electorate: ['pk-other'],
          votedCount: 0,
          electorateCount: 1,
          responses: [],
        },
      },
      { ...said('new-2', 'Milo', 9), durableFact: { kind: 'merge' as const } },
      { ...said('new-3', 'Sol', 12, 'over to @you'), mentionPubkeys: [VIEWER] },
    ];
    const report = buildCatchUpReport({
      messages,
      boundaryId: 'new-0',
      newestId: 'new-3',
      viewerPubkey: VIEWER,
    });

    expect(report?.summary).toBe(
      '4 messages from Sol, Nerd and 1 other. 1 poll opened, 1 merge landed, you were mentioned once.',
    );
  });

  it('CHEV-06: puts decisions and action items in ONE list, each attributed', () => {
    const messages = [
      said('new-0', 'Sol', 0),
      {
        ...said('new-1', 'Nerd', 5),
        choice: {
          choiceId: 'c1',
          mode: 'poll' as const,
          status: 'open' as const,
          agent: identity('Nerd'),
          requester: identity('Niglet'),
          prompt: 'Ship Friday?',
          options: [],
          electorate: [VIEWER],
          votedCount: 0,
          electorateCount: 1,
          responses: [],
        },
      },
      {
        ...said('new-2', 'Hoots', 7),
        writePermission: {
          permissionId: 'p1',
          requestId: 'r1',
          agentPubkey: 'pk-Hoots',
          requesterPubkey: 'pk-Hoots',
          tool: 'edit',
          repository: 'beeline',
          status: 'pending' as const,
        },
      },
      { ...said('new-3', 'Sol', 12, '  @you  take  this   one  '), mentionPubkeys: [VIEWER] },
    ];
    const report = buildCatchUpReport({
      messages,
      boundaryId: 'new-0',
      newestId: 'new-3',
      viewerPubkey: VIEWER,
    });

    expect(report?.needsYou).toEqual([
      {
        id: 'new-1:choice',
        kind: 'decision',
        text: 'Ship Friday?',
        // The person who asked for the poll, not the agent that posted it.
        requesterName: 'Niglet',
        at: at(5),
      },
      {
        id: 'new-2:write-permission',
        kind: 'decision',
        text: 'Repository edit waiting on you: beeline',
        requesterName: 'Hoots',
        at: at(7),
      },
      {
        id: 'new-3:mention',
        kind: 'action',
        text: '@you take this one',
        requesterName: 'Sol',
        at: at(12),
      },
    ]);
  });

  it('CHEV-06: leaves out what is not waiting on this reader', () => {
    const answered = {
      ...said('new-1', 'Nerd', 5),
      choice: {
        choiceId: 'c1',
        mode: 'poll' as const,
        status: 'open' as const,
        agent: identity('Nerd'),
        prompt: 'Ship Friday?',
        options: [],
        electorate: [VIEWER],
        votedCount: 1,
        electorateCount: 1,
        responses: [{ identityId: VIEWER, optionId: 'yes' }],
      },
    };
    const someoneElses = {
      ...said('new-2', 'Nerd', 6),
      choice: { ...answered.choice, choiceId: 'c2', electorate: ['pk-other'], responses: [] },
    };
    const settled = {
      ...said('new-3', 'Hoots', 7),
      writePermission: {
        permissionId: 'p1',
        requestId: 'r1',
        agentPubkey: 'pk-Hoots',
        requesterPubkey: 'pk-Hoots',
        tool: 'edit',
        repository: 'beeline',
        status: 'allowed' as const,
      },
    };
    const report = buildCatchUpReport({
      messages: [said('new-0', 'Sol', 0), answered, someoneElses, settled],
      boundaryId: 'new-0',
      newestId: 'new-3',
      viewerPubkey: VIEWER,
    });

    expect(report?.needsYou).toEqual([]);
  });
});
