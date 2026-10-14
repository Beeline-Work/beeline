import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import type { ChatDisplayMessage } from './room-view-presentation';
import { buildCatchUpReport, catchUpClock } from './room-catch-up-report';
import { foldPrLifecycleRuns } from './pr-lifecycle';

const VIEWER = 'pk-viewer';
const AT_0804 = new Date(2026, 8, 22, 8, 4).getTime() / 1000;

function at(minutesAfterStart: number): number {
  return AT_0804 + minutesAfterStart * 60;
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
  it('CHEV-04: states the range by its two ends, boundary through newest', () => {
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

    expect(report?.range).toEqual({
      boundaryId: 'new-0',
      newestId: 'new-2',
      startedAt: at(10),
      endedAt: at(102),
    });
    // The head names the window. It cannot name a size: these are the rows
    // the client happens to hold, not the run the reader actually missed.
    expect(report?.rangeLabel).toBe(
      `Since ${catchUpClock(at(10))} · newest ${catchUpClock(at(102))}`,
    );
    expect(report?.rangeLabel).not.toMatch(/\d+\s*(msgs?|messages?)/);
    // The row before the boundary is read history and is not in the range.
    expect(report?.summary).toBe('Sol: new-0. Nerd: new-1. Sol: new-2.');
    expect(report?.summary).not.toMatch(/^\d/);
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
      'Nerd: Ship Friday? Milo: new-2. Sol: over to @you.',
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

  it('CHEV-03: rolls the range by speaker identity, not by display name', () => {
    // Two DIFFERENT people both called Sol. Deduplicating the name strings
    // lost the second one; the handle is what tells them apart.
    const sol = said('new-0', 'Sol', 0);
    const otherSol = {
      ...said('new-1', 'Sol', 2),
      authorIdentity: { pubkey: 'pk-other', kind: 'human' as const, name: 'Sol', handle: 'sol-two' },
    };
    const report = buildCatchUpReport({
      messages: [{ ...sol, authorIdentity: { ...sol.authorIdentity!, handle: 'sol' } }, otherSol],
      boundaryId: 'new-0',
      newestId: 'new-1',
      viewerPubkey: VIEWER,
    });
    expect(report?.summary).toBe('Sol (@sol): new-0. Sol (@sol-two): new-1.');
  });

  it('CHEV-13: names the person who asked for an edit, not the agent that filed it', () => {
    // A permission card is authored by the agent that wants the edit and
    // carries its requester by pubkey. Attributing the card to its author put
    // the agent's name against a decision a person had asked for.
    const card = {
      ...said('new-1', 'Hoots', 5),
      writePermission: {
        permissionId: 'p1',
        requestId: 'r1',
        agentPubkey: 'pk-Hoots',
        requesterPubkey: 'pk-lunchbox',
        tool: 'edit',
        repository: 'beeline',
        status: 'pending' as const,
      },
    };
    const messages = [said('new-0', 'Sol', 0), card];
    const base = { messages, boundaryId: 'new-0', newestId: 'new-1', viewerPubkey: VIEWER };

    expect(
      buildCatchUpReport({
        ...base,
        identities: new Map([['pk-lunchbox', { pubkey: 'pk-lunchbox', name: 'lunchboxfortwo' }]]),
      })?.needsYou,
    ).toEqual([
      {
        id: 'new-1:write-permission',
        kind: 'decision',
        text: 'Repository edit waiting on you: beeline',
        requesterName: 'lunchboxfortwo',
        at: at(5),
      },
    ]);

    // An unresolvable requester is not the author by default. Saying "Hoots"
    // here would be naming the wrong person, which is worse than naming none.
    expect(buildCatchUpReport(base)?.needsYou[0]?.requesterName).toBe('Someone');

    // When the requester IS the author, the row's own identity answers it.
    expect(
      buildCatchUpReport({
        ...base,
        messages: [
          messages[0]!,
          { ...card, writePermission: { ...card.writePermission, requesterPubkey: 'pk-Hoots' } },
        ],
      })?.needsYou[0]?.requesterName,
    ).toBe('Hoots');
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


describe('Reproduction catch-up-1', () => {
  const first = Date.parse('2026-10-14T19:26:00Z') / 1000;
  const last = Date.parse('2026-10-14T19:45:00Z') / 1000;
  const unread = [
    { ...said('first', 'Ruby', 0, 'The fix merged and Android verification passed.'), timestamp: first },
    { ...said('last', 'Ruby', 0, 'The release failed because the build timed out.'), timestamp: last },
  ];
  const build = (messages = unread) => buildCatchUpReport({ messages, boundaryId: 'first', newestId: 'last', viewerPubkey: VIEWER });

  it('uses seconds and the device local clock across a non-UTC unread window', () => {
    const expected = (seconds: number) => {
      const date = new Date(seconds * 1000);
      return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
    };
    expect(catchUpClock(first)).toBe(expected(first));
    expect(catchUpClock(last)).toBe(expected(last));
    expect(build()?.rangeLabel).toBe(`Since ${expected(first)} · newest ${expected(last)}`);
    expect(catchUpClock(first)).not.toBe(catchUpClock(last));
    expect(build()?.range).toMatchObject({ startedAt: first, endedAt: last });
  });

  it('formats the production timestamps in a non-UTC device time zone', () => {
    const moduleUrl = new URL('./room-catch-up-report.ts', import.meta.url).href;
    const output = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
      `import { catchUpClock } from ${JSON.stringify(moduleUrl)}; console.log(catchUpClock(${first}), catchUpClock(${last}));`,
    ], { env: { ...process.env, TZ: 'America/New_York' }, encoding: 'utf8' });
    expect(output.trim()).toBe('15:26 15:45');
  });

  it('states the unread merge result and failure instead of a speaker roll', () => {
    expect(build()?.summary).toBe('Ruby: The fix merged and Android verification passed. Ruby: The release failed because the build timed out.');
  });

  it('keeps decisions and outcomes ahead of routine messages, in at most three sentences', () => {
    const messages = [unread[0]!, said('decision', 'Ruby', 1, 'We decided to ship tomorrow.'), ...Array.from({ length: 6 }, (_, i) => said(`routine-${i}`, 'Ruby', i + 2, 'Still checking the logs.')), unread[1]!];
    expect(build(messages)?.summary).toBe('Ruby: The fix merged and Android verification passed. Ruby: We decided to ship tomorrow. Ruby: The release failed because the build timed out.');
  });

  it('returns an unavailable summary for missing or deleted content', () => {
    expect(build(unread.map((message) => ({ ...message, text: '' })))?.summary).toBeNull();
    expect(build(unread.map((message) => ({ ...message, deleted: true })))?.summary).toBeNull();
  });
});


it('keeps multiple outcome sentences from one unread reply and preserves links', () => {
  const message = said('only', 'Ruby', 0, 'The fix merged. The release failed. Details are at https://github.com/acme/repo/pull/42.');
  const report = buildCatchUpReport({ messages: [message], boundaryId: 'only', newestId: 'only', viewerPubkey: VIEWER });
  expect(report?.summary).toBe('Ruby: The fix merged. Ruby: The release failed. Ruby: Details are at https://github.com/acme/repo/pull/42.');
});


it('uses the first and last original unread messages when the transcript folds their cards', () => {
  const first = Date.parse('2026-10-14T19:26:00Z') / 1000;
  const messages = ['opened', 'merged'].map((action, index): ChatDisplayMessage => ({
    id: `pr-${index}`, timestamp: first + index * 19 * 60, text: `Catch up fix ${action}.`, isUser: false,
    githubEvent: { type: 'pull-request', action, title: 'Catch up fix', actor: 'ruby', branch: 'fix', url: 'https://github.com/acme/repo/pull/42' },
  }));
  expect(foldPrLifecycleRuns(messages)).toHaveLength(1);
  const report = buildCatchUpReport({ messages, boundaryId: 'pr-0', newestId: 'pr-1', viewerPubkey: VIEWER });
  expect(report?.range).toMatchObject({ startedAt: first, endedAt: first + 19 * 60 });
  expect(report?.summary).toContain('Catch up fix merged.');
});
