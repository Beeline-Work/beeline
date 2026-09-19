import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { approveMerge, prChecksStatus } from './read-only-mcp.js';

const url = 'https://github.com/owner/widgets/pull/614';
let restore: Record<string, unknown>, items: Record<string, unknown>[];
let checks: string, approvalPending: boolean;
let reviewer: string | null, reviewerIsAuthor: boolean, gateRule: string;
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
  reviewerIsAuthor = false;
  gateRule = "Only @reviewer's approve_merge clears this gate; tagging or asking any other agent to review cannot record an approval or change this verdict.";
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
          : name === 'getWorkspaceRoster'
            ? {
                members: [
                  {
                    kind: 'agent',
                    identityId: 'agent',
                    role: 'member',
                    soul: { authoredBy: 'owner' },
                  },
                  { kind: 'human', identityId: 'human', role: 'member' },
                  { kind: 'human', identityId: 'owner', handle: 'captain', role: 'member' },
                  { kind: 'human', identityId: 'admin', handle: 'ada', role: 'admin' },
                  { kind: 'human', identityId: 'member-b', handle: 'sam', role: 'member' },
                ],
              }
            : name === 'getAgentConfiguration'
              ? { commands: [], yoloMode: false, ownerIdentityId: 'owner' }
            : name === 'getRoomAuthority'
              ? { archived: false }
              : name === 'getPrChecksStatus'
                ? {
                  checks,
                  pullRequest: url,
                  headSha: 'a'.repeat(40),
                  approvalPending,
                  reviewer,
                  reviewerIsAuthor,
                  ...(reviewerWake ? { reviewerWake } : {}),
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
  it('retains human holds and the server PR/head-bound approval verdict', async () => {
    approvalPending = true;
    items = [
      { authorId: 'human', body: 'hold' },
      { authorId: 'agent', body: 'merge now' },
    ];
    expect(JSON.parse(await prChecksStatus({ pullRequest: 614 }))).toMatchObject({
      held: true,
      approvalPending: true,
    });
    items.push({ authorId: 'human', body: 'proceed' });
    expect(JSON.parse(await prChecksStatus({ pullRequest: 614 }))).toMatchObject({
      held: false,
      approvalPending: true,
    });
  });
  it('lets an agent-owner command override a member hold', async () => {
    items = [
      { authorId: 'human', body: 'hold' },
      { authorId: 'owner', body: 'proceed' },
    ];
    expect(JSON.parse(await prChecksStatus({ pullRequest: 614 }))).toMatchObject({ held: false });
  });
  it('lets a workspace admin command override a member hold', async () => {
    items = [
      { authorId: 'human', body: 'hold' },
      { authorId: 'admin', body: 'go ahead' },
    ];
    expect(JSON.parse(await prChecksStatus({ pullRequest: 614 }))).toMatchObject({ held: false });
  });
  it('keeps a member hold against another member command', async () => {
    items = [
      { authorId: 'human', body: 'hold' },
      { authorId: 'member-b', body: 'proceed' },
    ];
    expect(JSON.parse(await prChecksStatus({ pullRequest: 614 }))).toMatchObject({ held: true });
  });
  it('ignores a member hold after the agent owner already ordered the action', async () => {
    items = [
      { authorId: 'owner', body: 'merge now' },
      { authorId: 'human', body: 'hold' },
    ];
    expect(JSON.parse(await prChecksStatus({ pullRequest: 614 }))).toMatchObject({ held: false });
  });
  it('ignores a member resume of a higher-tier hold', async () => {
    items = [
      { authorId: 'owner', body: 'hold' },
      { authorId: 'human', body: 'proceed' },
    ];
    expect(JSON.parse(await prChecksStatus({ pullRequest: 614 }))).toMatchObject({ held: true });
  });
  it('names the ranked hold rule beside the merge-conditions rule', async () => {
    const result = JSON.parse(await prChecksStatus({ pullRequest: 614 }));
    expect(result.rule).toContain('A member cannot stop an action your owner ordered');
    expect(result.rule).not.toContain('agentOwner');
    expect(result.rule).not.toContain('workspaceRole');
    expect(result.rule).toContain('Merge only when checks is passed');
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
    expect(result.rule).toContain('Merge only when checks is passed');
  });
  it('reports self-review as no gate when the opener is also the reviewer', async () => {
    reviewerIsAuthor = true;
    gateRule =
      "You opened this corner and are also this Room's configured reviewer (@reviewer), so self-review is not required.";
    expect(JSON.parse(await prChecksStatus({ pullRequest: 614 }))).toMatchObject({
      reviewer: '@reviewer',
      reviewerIsAuthor: true,
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
    expect(JSON.parse(await prChecksStatus({ pullRequest: 614 }))).toMatchObject({
      checks: 'unknown',
      reason: `no checks are recorded for PR #614 (head ${'a'.repeat(40)}); the PR may have been opened from a branch that is not this corner's, or checks have not reported yet`,
      held: false,
      approvalPending: false,
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
