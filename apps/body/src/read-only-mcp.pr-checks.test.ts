import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { approveMerge, prChecksStatus } from './read-only-mcp.js';

const url = 'https://github.com/owner/widgets/pull/614';
let restore: Record<string, unknown>, items: Record<string, unknown>[];
let checks: string, approved: boolean;
let reviewer: string | null, reviewerExists: boolean, reviewerIsAuthor: boolean;
let held: boolean, mergeAllowed: boolean;
let reviewerWake: { status: string; detail: string } | undefined;
let calls: { name: string; input: Record<string, unknown> }[];
let checkTally: Record<string, unknown>;
beforeEach(() => {
  for (const [key, value] of Object.entries({
    BEELINE_DAEMON_CORNER_ID: 'corner',
    BEELINE_DAEMON_WORKSPACE_ID: 'workspace',
    BEELINE_DAEMON_AGENT_ID: 'agent',
    BEELINE_DAEMON_BASE_URL: 'http://localhost:1234',
    BEELINE_DAEMON_TOKEN: 'test-token',
  }))
    vi.stubEnv(key, value);
  restore = { objective: 'Review PR 614', lifecycle: { checks: 'unknown', lifecycle: 'working' } };
  items = [];
  checks = 'passed';
  approved = true;
  reviewer = '@reviewer';
  reviewerExists = true;
  reviewerIsAuthor = false;
  held = false;
  mergeAllowed = true;
  reviewerWake = {
    status: 'dispatched',
    detail: 'The checks-passed transition woke @reviewer.',
  };
  calls = [];
  checkTally = {};
  vi.stubGlobal('fetch', async (input: URL, init: RequestInit) => {
    const name = new URL(input).pathname.split('/').pop()!;
    calls.push({ name, input: JSON.parse(String(init.body)) });
    const result =
      name === 'getCornerRestoreState'
        ? restore
        : name === 'getRoomConversation'
          ? { items }
          : name === 'getRoomAuthority'
            ? { archived: false }
            : name === 'getPrChecksStatus'
              ? {
                  stage: 'waiting_for_yes',
                  checks,
                  ...checkTally,
                  pullRequest: url,
                  headSha: 'a'.repeat(40),
                  approved,
                  reviewer,
                  reviewerExists,
                  reviewerIsAuthor,
                  ...(reviewerWake ? { reviewerWake } : {}),
                  held,
                  holds: held ? [{ id: 'hold-1', actorId: 'human', standing: 'owner', setAt: '2026-10-02' }] : [],
                  mergeAllowed,
                }
              : name === 'approveCornerMerge'
                ? { status: 'approved', pullRequestNumber: 614, headSha: 'a'.repeat(40) }
                : {};
    return Response.json(result);
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
const gateCalls = () => calls.filter((call) => call.name === 'getPrChecksStatus');

describe('pr_checks_status PR selection and reviewer gate', () => {
  it('adds no hold of its own to a corner with no pull request yet', async () => {
    restore = { lane: 'code', objective: 'Investigate' };
    const status = JSON.parse(await prChecksStatus());
    expect(status).toMatchObject({
      held: false,
      mergeAllowed: false,
      approved: false,
    });
    expect(status).not.toHaveProperty('didHumanSayDontMerge');
    expect(status.next).toContain('The PR URL is not yet durable');
    expect(gateCalls()).toHaveLength(0);
  });
  it.each([614, url])(
    'asks the server about an explicit reviewer target %s',
    async (pullRequest) => {
      expect(JSON.parse(await prChecksStatus({ pullRequest }))).toMatchObject({
        checks: 'passed',
        pullRequest: url,
      });
      expect(gateCalls()).toEqual([
        { name: 'getPrChecksStatus', input: { cornerId: 'corner', pullRequest } },
      ]);
    },
  );
  it('defaults to the author PR even when chat contains a different PR', async () => {
    restore = { lifecycle: { pr: { url }, checks: 'passing' } };
    items = [{ body: 'https://github.com/owner/widgets/pull/999' }];
    await prChecksStatus();
    expect(gateCalls()[0]!.input.pullRequest).toBe(url);
  });
  it('uses an objective or transcript URL as a target hint', async () => {
    restore.objective = `Review ${url}`;
    await prChecksStatus();
    expect(gateCalls()[0]!.input.pullRequest).toBe(url);
    restore.objective = 'Review PR';
    items = [{ body: url }];
    await prChecksStatus();
    expect(gateCalls()[1]!.input.pullRequest).toBe(url);
  });
  it('never turns prose or an unrelated green lifecycle into a passed target verdict', async () => {
    restore.lifecycle = {
      checks: 'passing',
      pr: { url: 'https://github.com/owner/widgets/pull/999' },
    };
    items = [{ authorId: 'agent', body: 'All checks passed' }];
    checks = 'failed';
    expect(JSON.parse(await prChecksStatus({ pullRequest: 614 }))).toMatchObject({
      checks: 'failed',
    });
    expect(gateCalls()[0]!.input.pullRequest).toBe(614);
  });
  it('takes the human hold from the server, never from its own transcript scan', async () => {
    items = [{ authorId: 'human', body: 'hold, do not merge' }];
    const first = JSON.parse(await prChecksStatus({ pullRequest: 614 }));
    expect(first).toMatchObject({
      held: false,
      mergeAllowed: true,
      approved: true,
    });
    expect(first).not.toHaveProperty('didHumanSayDontMerge');
    held = true;
    mergeAllowed = false;
    items = [{ authorId: 'human', body: 'proceed' }];
    const second = JSON.parse(await prChecksStatus({ pullRequest: 614 }));
    expect(second).toMatchObject({
      held: true,
      holds: [{ id: 'hold-1', actorId: 'human', standing: 'owner', setAt: '2026-10-02' }],
      mergeAllowed: false,
      approved: true,
    });
    expect(second).not.toHaveProperty('didHumanSayDontMerge');
    // The hold is the server's fact: no local lookup remains.
    expect(calls.map((call) => call.name)).not.toContain('getWorkspaceRoster');
    expect(calls.map((call) => call.name)).not.toContain('getAgentConfiguration');
  });
  it.each([
    {
      name: 'no configured reviewer and no yes',
      setup: () => {
        reviewer = null;
        reviewerExists = false;
        approved = false;
        mergeAllowed = false;
      },
      expected: { reviewerExists: false, approved: false, mergeAllowed: false },
    },
    {
      name: 'a yes on the current head and no hold',
      setup: () => undefined,
      expected: { approved: true, held: false, mergeAllowed: true },
    },
    {
      name: 'no yes on the current head',
      setup: () => {
        approved = false;
        mergeAllowed = false;
      },
      expected: { approved: false, mergeAllowed: false },
    },
    {
      name: 'a hold despite a yes',
      setup: () => {
        held = true;
        mergeAllowed = false;
      },
      expected: { approved: true, held: true, mergeAllowed: false },
    },
  ])('reports the server merge gate: $name', async ({ setup, expected }) => {
    setup();
    const status = JSON.parse(await prChecksStatus({ pullRequest: 614 }));
    expect(status).toMatchObject(expected);
    expect(status).not.toHaveProperty('didHumanSayDontMerge');
  });
  it('Reproduction CI-STATUS-1: reports running checks with counts and pending names', async () => {
    checks = 'pending';
    checkTally = {
      checkCount: 35,
      checkStates: {
        passed: 33,
        pending: 2,
        failed: 0,
        unlisted: 0,
        pendingNames: ['SERVER SUITE', 'DESKTOP BUILD (macos-universal)'],
        failedNames: [],
      },
    };
    const status = JSON.parse(await prChecksStatus({ pullRequest: 614 }));
    expect(status).toMatchObject({ checks: 'pending', checkCount: 35, checkStates: checkTally.checkStates });
    expect(status.reason).toBe(
      '33 of 35 checks passed, 2 pending (SERVER SUITE, DESKTOP BUILD (macos-universal)), 0 failed',
    );
  });
  it('names failed checks and says how many names and contexts are cut short', async () => {
    checks = 'failed';
    checkTally = {
      checkCount: 130,
      checkStates: {
        passed: 85,
        pending: 3,
        failed: 12,
        unlisted: 30,
        pendingNames: ['a', 'b', 'c'],
        failedNames: ['f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9', 'f10'],
      },
    };
    expect(JSON.parse(await prChecksStatus({ pullRequest: 614 })).reason).toBe(
      '85 of 130 checks passed, 3 pending (a, b, c), 12 failed (f1, f2, f3, f4, f5, f6, f7, f8, f9, f10, and 2 more); 30 more not listed',
    );
  });
  it('says no check has reported only when the head has no contexts', async () => {
    checks = 'pending';
    checkTally = {
      checkCount: 0,
      checkStates: { passed: 0, pending: 0, failed: 0, unlisted: 0, pendingNames: [], failedNames: [] },
    };
    expect(JSON.parse(await prChecksStatus({ pullRequest: 614 })).reason).toBe(
      `no checks have reported for head ${'a'.repeat(40)} yet`,
    );
  });
  it('never opens the gate itself when the server says it is shut', async () => {
    // Every local fact looks green, but only the server's mergeAllowed counts.
    mergeAllowed = false;
    expect(JSON.parse(await prChecksStatus({ pullRequest: 614 }))).toMatchObject({
      checks: 'passed',
      approved: true,
      held: false,
      reviewerExists: true,
      mergeAllowed: false,
    });
  });
  it('passes through the named reviewer and returns facts, not a rule', async () => {
    const result = JSON.parse(await prChecksStatus({ pullRequest: 614 }));
    expect(result).toMatchObject({
      stage: 'waiting_for_yes',
      reviewer: '@reviewer',
      reviewerIsAuthor: false,
      reviewerWake: {
        status: 'dispatched',
        detail: 'The checks-passed transition woke @reviewer.',
      },
    });
    expect(result).not.toHaveProperty('rule');
    expect(result).not.toHaveProperty('isWorkerYolo');
  });
  it('reports a self-reviewed corner as waiting for a person\'s yes', async () => {
    reviewerIsAuthor = true;
    approved = false;
    mergeAllowed = false;
    expect(JSON.parse(await prChecksStatus({ pullRequest: 614 }))).toMatchObject({
      reviewer: '@reviewer',
      reviewerIsAuthor: true,
      approved: false,
      mergeAllowed: false,
    });
  });
  it('fails closed on a server error instead of using green chat prose', async () => {
    items = [{ body: 'all checks passed' }];
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('{}', { status: 503 })));
    await expect(prChecksStatus({ pullRequest: 614 })).rejects.toThrow();
  });
  it('reports unknown with the PR and head reason when the server has no check facts', async () => {
    checks = 'unknown';
    mergeAllowed = false;
    expect(JSON.parse(await prChecksStatus({ pullRequest: 614 }))).toMatchObject({
      checks: 'unknown',
      reason: `no checks are recorded for PR #614 (head ${'a'.repeat(40)}); the PR may have been opened from a branch that is not this corner's, or checks have not reported yet`,
      held: false,
      mergeAllowed: false,
      approved: true,
    });
  });
  it('asks for a PR when none is known without interpreting chat as authorization', async () => {
    items = [{ body: 'all checks passed' }];
    expect(JSON.parse(await prChecksStatus())).toMatchObject({
      checks: 'unknown',
      reason: 'no pull request or checks are recorded for this corner',
      next: expect.any(String),
    });
    expect(gateCalls()).toHaveLength(0);
  });
});

describe('approve_merge', () => {
  it('records the exact full head through the reviewer-only daemon operation', async () => {
    await expect(approveMerge({ headSha: 'A'.repeat(40) })).resolves.toContain('"approved"');
    expect(calls).toContainEqual({
      name: 'approveCornerMerge',
      input: { cornerId: 'corner', headSha: 'a'.repeat(40) },
    });
  });

  it('refuses a shortened revision before calling the server', async () => {
    await expect(approveMerge({ headSha: 'abc123' })).rejects.toThrow(
      'headSha must be a full 40-character SHA',
    );
    expect(calls).toEqual([]);
  });
});
