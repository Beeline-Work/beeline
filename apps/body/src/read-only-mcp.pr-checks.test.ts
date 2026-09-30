import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { approveMerge, prChecksStatus } from './read-only-mcp.js';

const url = 'https://github.com/owner/widgets/pull/614';
let restore: Record<string, unknown>, items: Record<string, unknown>[];
let checks: string, approvalPending: boolean;
let reviewer: string | null, reviewerExists: boolean, reviewerIsAuthor: boolean, gateRule: string;
let held: boolean, isWorkerYolo: boolean, mergeAllowed: boolean;
let reviewerWake: { status: string; detail: string } | undefined;
let calls: { name: string; input: Record<string, unknown> }[];
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
  approvalPending = false;
  reviewer = '@reviewer';
  reviewerExists = true;
  reviewerIsAuthor = false;
  held = false;
  isWorkerYolo = true;
  mergeAllowed = true;
  gateRule =
    "Only @reviewer's approve_merge clears this gate; tagging or asking any other agent to review cannot record an approval or change this verdict.";
  reviewerWake = {
    status: 'dispatched',
    detail: 'The checks-passed transition woke @reviewer.',
  };
  calls = [];
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
                  checks,
                  pullRequest: url,
                  headSha: 'a'.repeat(40),
                  approvalPending,
                  reviewer,
                  reviewerExists,
                  reviewerIsAuthor,
                  ...(reviewerWake ? { reviewerWake } : {}),
                  held,
                  isWorkerYolo,
                  mergeAllowed,
                  rule: gateRule,
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
  it('keeps a research hold even after a human says to proceed and a reviewer passes', async () => {
    restore.lane = 'research';
    held = true;
    mergeAllowed = false;
    items = [{ authorId: 'human', body: 'proceed and merge now' }];
    const status = JSON.parse(await prChecksStatus({ pullRequest: 614 }));
    expect(status).toMatchObject({
      held: true,
      mergeAllowed: false,
      approvalPending: true,
    });
    expect(status.rule).toContain('durable hold');
    expect(status.rule).not.toContain('squash-merges');
  });
  it('holds a research corner with no pull request yet', async () => {
    restore = { lane: 'research', objective: 'Investigate' };
    expect(JSON.parse(await prChecksStatus())).toMatchObject({
      held: true,
      didHumanSayDontMerge: true,
      isWorkerYolo: false,
      mergeAllowed: false,
      approvalPending: true,
    });
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
    expect(JSON.parse(await prChecksStatus({ pullRequest: 614 }))).toMatchObject({
      held: false,
      didHumanSayDontMerge: false,
      mergeAllowed: true,
      approvalPending: false,
    });
    held = true;
    mergeAllowed = false;
    items = [{ authorId: 'human', body: 'proceed' }];
    expect(JSON.parse(await prChecksStatus({ pullRequest: 614 }))).toMatchObject({
      held: true,
      didHumanSayDontMerge: true,
      mergeAllowed: false,
      approvalPending: true,
    });
    // The hold and yolo mode are the server's facts: no local lookup remains.
    expect(calls.map((call) => call.name)).not.toContain('getWorkspaceRoster');
    expect(calls.map((call) => call.name)).not.toContain('getAgentConfiguration');
  });
  it.each([
    {
      name: 'worker yolo off after reviewer PASS',
      setup: () => {
        isWorkerYolo = false;
        mergeAllowed = false;
      },
      expected: { isWorkerYolo: false, mergeAllowed: false, approvalPending: true },
    },
    {
      name: 'no configured reviewer with worker yolo on',
      setup: () => {
        reviewer = null;
        reviewerExists = false;
        mergeAllowed = false;
      },
      expected: { reviewerExists: false, mergeAllowed: false, approvalPending: true },
    },
    {
      name: 'reviewer PASS with worker yolo on and no human hold',
      setup: () => undefined,
      expected: {
        reviewFailed: false,
        isWorkerYolo: true,
        held: false,
        mergeAllowed: true,
        approvalPending: false,
      },
    },
    {
      name: 'reviewer FAIL or no PASS on the current head',
      setup: () => {
        approvalPending = true;
        mergeAllowed = false;
      },
      expected: { reviewFailed: true, mergeAllowed: false, approvalPending: true },
    },
    {
      name: 'human hold despite reviewer PASS and worker yolo on',
      setup: () => {
        held = true;
        mergeAllowed = false;
      },
      expected: { held: true, didHumanSayDontMerge: true, approvalPending: true },
    },
  ])('reports the server merge gate: $name', async ({ setup, expected }) => {
    setup();
    expect(JSON.parse(await prChecksStatus({ pullRequest: 614 }))).toMatchObject(expected);
  });
  it('never opens the gate itself when the server says it is shut', async () => {
    // Every local fact looks green, but only the server's mergeAllowed counts.
    mergeAllowed = false;
    expect(JSON.parse(await prChecksStatus({ pullRequest: 614 }))).toMatchObject({
      checks: 'passed',
      reviewFailed: false,
      isWorkerYolo: true,
      held: false,
      reviewerExists: true,
      mergeAllowed: false,
      approvalPending: true,
    });
  });
  it('passes through the named reviewer and folds the server rule into the merge-conditions rule', async () => {
    const result = JSON.parse(await prChecksStatus({ pullRequest: 614 }));
    expect(result).toMatchObject({
      reviewer: '@reviewer',
      reviewerIsAuthor: false,
      reviewerWake: {
        status: 'dispatched',
        detail: 'The checks-passed transition woke @reviewer.',
      },
    });
    expect(result.rule).toContain(gateRule);
    expect(result.rule).toContain(
      'When mergeAllowed is true the server squash-merges this exact head itself; no agent runs gh pr merge.',
    );
    expect(result.rule).toContain('the server wakes the implementer with its reason');
    expect(result.rule).toContain('missing state is never consent');
    expect(result.rule).not.toContain('YOU merge');
    expect(result.rule).not.toContain('The server never merges');
  });
  it('reports self-review as no gate when the opener is also the reviewer', async () => {
    reviewerIsAuthor = true;
    gateRule =
      "You opened this corner and are also this Room's configured reviewer (@reviewer), so self-review is not required.";
    expect(JSON.parse(await prChecksStatus({ pullRequest: 614 }))).toMatchObject({
      reviewer: '@reviewer',
      reviewerIsAuthor: true,
      mergeAllowed: true,
      approvalPending: false,
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
      approvalPending: true,
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
