import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { AcpClient } from './acp.js';
import { Body, LANDED_TAG, type SubchannelInfo } from './body.js';
import type { NostrEvent } from '@beeline/nostr';

const cleanup: string[] = [];

function run(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
  return (result.stdout ?? '').trim();
}

async function repository(): Promise<{
  root: string;
  remote: string;
  worktree: string;
  info: SubchannelInfo;
  body: Body;
}> {
  const root = await mkdtemp(resolve(tmpdir(), 'beeline-github-delivery-'));
  cleanup.push(root);
  const remote = resolve(root, 'remote.git');
  const checkout = resolve(root, 'checkout');
  const worktree = resolve(root, 'corner');
  await writeFile(resolve(root, 'seed'), 'seed\n');
  run(root, ['init', '--bare', '-q', remote]);
  run(root, ['init', '-q', '-b', 'main', checkout]);
  run(checkout, ['config', 'user.name', 'Operator']);
  run(checkout, ['config', 'user.email', 'operator@example.com']);
  await writeFile(resolve(checkout, 'README.md'), '# scratch\n');
  run(checkout, ['add', 'README.md']);
  run(checkout, ['commit', '-m', 'seed']);
  run(checkout, ['remote', 'add', 'origin', remote]);
  run(checkout, ['push', '-u', 'origin', 'main']);
  run(checkout, ['worktree', 'add', '-q', '-b', 'feature/corner', worktree, 'main']);
  await writeFile(resolve(worktree, 'LANDED.txt'), 'landed by the agent\n');
  run(worktree, ['add', 'LANDED.txt']);
  run(worktree, ['commit', '-m', 'Add landed proof']);

  const body = new Body({
    agentBinary: '/bin/false',
    mcpBinary: '/bin/false',
    agentEnv: {},
    workspaceRoot: root,
    relayBaseUrl: 'http://relay.test',
    relayHost: 'relay.test',
    relayScheme: 'http',
    relayWsUrl: 'ws://relay.test',
    autoApprovePermissions: true,
  });
  const session = {
    channelId: 'corner-channel',
    sessionId: 'session',
    client: new AcpClient({ agentBinary: '/bin/false', agentEnv: {} }),
    mode: 'edit' as const,
    parentChannelId: 'room-channel',
    worktreePath: worktree,
    featureBranch: 'feature/corner',
  };
  const info: SubchannelInfo = {
    subchannelId: 'corner-channel',
    worktreePath: worktree,
    featureBranch: 'feature/corner',
    role: body.agent,
    session,
    lastPolledAt: 0,
    archived: false,
    boundRepo: {
      repo: 'scratch',
      localPath: checkout,
      remoteName: 'origin',
      targetBranch: 'refs/heads/main',
      repositoryKey: 'github-scratch',
    },
  };
  body.registerSubchannel(info);
  return { root: checkout, remote, worktree, info, body };
}

function captureEvents(): NostrEvent[] {
  const events: NostrEvent[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      events.push(JSON.parse(String(init?.body)) as NostrEvent);
      return new Response(JSON.stringify({ accepted: true }), { status: 200 });
    }),
  );
  return events;
}

async function publish(body: Body, info: SubchannelInfo): Promise<boolean> {
  const publishMergeReady = Reflect.get(body, 'publishMergeReady') as (
    this: Body,
    value: SubchannelInfo,
  ) => Promise<boolean>;
  return publishMergeReady.call(body, info);
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('GitHub-origin delivery', () => {
  it('refuses merge-ready when the agent worktree still has uncommitted changes', async () => {
    const { worktree, info, body } = await repository();
    const events = captureEvents();
    await writeFile(resolve(worktree, 'UNCOMMITTED.txt'), 'must be committed first\n');

    await expect(publish(body, info)).resolves.toBe(false);
    expect(info.mergeTarget).toBeUndefined();
    expect(
      events.some((event) => event.tags.some((tag) => tag[0] === 't' && tag[1] === 'merge-ready')),
    ).toBe(false);
    expect(
      events.find((event) =>
        event.tags.some((tag) => tag[0] === 't' && tag[1] === 'merge-not-ready'),
      )?.content,
    ).toContain('Nothing ready to merge yet');
  });

  it('publishes review-ready work without autonomously landing or archiving it', async () => {
    const { remote, worktree, info, body } = await repository();
    const events = captureEvents();
    const tip = run(worktree, ['rev-parse', 'HEAD']);
    const mainBefore = run(worktree, ['ls-remote', remote, 'refs/heads/main']).split(/\s+/)[0]!;

    await expect(publish(body, info)).resolves.toBe(true);
    expect(run(worktree, ['ls-remote', remote, 'refs/heads/feature/corner'])).toContain(tip);
    expect(run(worktree, ['ls-remote', remote, 'refs/heads/main'])).toContain(mainBefore);
    expect(info.mergeTarget).toEqual({
      repo: 'remote/github-scratch',
      branch: 'refs/heads/main',
      tip,
    });
    expect(
      events.some((event) => event.tags.some((tag) => tag[0] === 't' && tag[1] === 'merge-ready')),
    ).toBe(true);
    expect(
      events.find((event) => event.tags.some((tag) => tag[0] === 't' && tag[1] === LANDED_TAG)),
    ).toBeUndefined();
    expect(info.humanMergeApproval).toBeUndefined();

    // Even if the target ref reaches the feature tip out-of-band, Body cannot
    // infer authority from repository state and archive the corner.
    run(worktree, ['push', remote, `${tip}:refs/heads/main`]);
    vi.spyOn(body as never, 'findHumanMergeApproval' as never).mockResolvedValue(
      undefined as never,
    );
    const archive = vi.spyOn(body, 'archiveSubchannel');
    await expect(body.pollMergeCompletions()).resolves.toBe(0);
    expect(archive).not.toHaveBeenCalled();
    expect(info.archived).toBe(false);
  });

  it('lands a non-relay target only after an exact human approval is recorded', async () => {
    const { remote, worktree, info, body } = await repository();
    const events = captureEvents();
    const tip = run(worktree, ['rev-parse', 'HEAD']);
    const mainBefore = run(worktree, ['ls-remote', remote, 'refs/heads/main']).split(/\s+/)[0]!;

    await expect(publish(body, info)).resolves.toBe(true);
    expect(run(worktree, ['ls-remote', remote, 'refs/heads/feature/corner'])).toContain(tip);
    expect(run(worktree, ['ls-remote', remote, 'refs/heads/main'])).toContain(mainBefore);
    info.humanMergeApproval = {
      id: 'signed-human-approval',
      reviewer: 'human-admin',
      tip,
    };
    vi.spyOn(body as never, 'findHumanMergeApproval' as never).mockResolvedValue(
      info.humanMergeApproval as never,
    );

    await expect(Reflect.get(body, 'pollDirectRemoteApprovals').call(body)).resolves.toBe(1);

    expect(run(worktree, ['ls-remote', remote, 'refs/heads/main'])).toContain(tip);
    expect(
      events.find((event) => event.tags.some((tag) => tag[0] === 't' && tag[1] === LANDED_TAG)),
    )?.toMatchObject({ content: `Human-approved work landed on refs/heads/main at ${tip}.` });
  });
});

/**
 * The captain repro: an approved corner whose target branch moved on between
 * approval and landing. The land is refused (correctly — the human approved an
 * exact tip), but the OLD behaviour stopped there: the approval stayed valid,
 * the same poll re-refused it on every maintenance tick, and the only way
 * forward was a person hand-driving a rebase. The corner dead-ended.
 */
describe('a land refused because the target moved on self-heals', () => {
  async function approvedCornerWithMovedTarget(): Promise<{
    root: string;
    remote: string;
    worktree: string;
    info: SubchannelInfo;
    body: Body;
    events: NostrEvent[];
    tip: string;
    moved: string;
    prompts: string[];
  }> {
    const { root, remote, worktree, info, body } = await repository();
    const events = captureEvents();
    const tip = run(worktree, ['rev-parse', 'HEAD']);
    await expect(publish(body, info)).resolves.toBe(true);

    // Someone else lands on main AFTER the human approved this exact tip.
    await writeFile(resolve(root, 'OTHER.md'), 'someone else landed first\n');
    run(root, ['add', 'OTHER.md']);
    run(root, ['commit', '-m', 'target moved on']);
    run(root, ['push', 'origin', 'main']);
    const moved = run(root, ['ls-remote', remote, 'refs/heads/main']).split(/\s+/)[0]!;

    info.humanMergeApproval = { id: 'signed-human-approval', reviewer: 'human-admin', tip };
    vi.spyOn(body as never, 'findHumanMergeApproval' as never).mockResolvedValue(
      info.humanMergeApproval as never,
    );
    // The corner's own agent turn: actually do the rebase the daemon asks for.
    const prompts: string[] = [];
    vi.spyOn(body as never, 'promptAgent' as never).mockImplementation((async (
      _session: unknown,
      prompt: string,
    ) => {
      prompts.push(prompt);
      run(worktree, ['fetch', 'origin', 'main']);
      run(worktree, ['rebase', 'origin/main']);
      return { agentText: 'Rebased onto the new main; no conflicts.', updates: [] };
    }) as never);

    return { root, remote, worktree, info, body, events, tip, moved, prompts };
  }

  it('asks the corner agent to rebase, then republishes a fresh review on the new tip', async () => {
    const { root, remote, worktree, info, body, events, tip, moved, prompts } =
      await approvedCornerWithMovedTarget();

    await expect(Reflect.get(body, 'pollDirectRemoteApprovals').call(body)).resolves.toBe(0);
    await body.waitForAgentTasks();

    // The protected branch is never advanced by the refusal or the self-heal.
    expect(run(root, ['ls-remote', remote, 'refs/heads/main'])).toContain(moved);
    // The rebase was asked for as a real corner turn, naming the moved target.
    expect(prompts.join('\n')).toContain('Rebase this corner');
    expect(prompts.join('\n')).toContain('feature/corner');
    const rebased = run(worktree, ['rev-parse', 'HEAD']);
    expect(rebased).not.toBe(tip);
    expect(run(worktree, ['merge-base', '--is-ancestor', moved, rebased])).toBe('');

    // ...and the human gets a brand-new review to approve on the rebased tip,
    // which is what turns the dead end back into a next step.
    const ready = events.filter((event) =>
      event.tags.some((tag) => tag[0] === 't' && tag[1] === 'merge-ready'),
    );
    expect(ready).toHaveLength(2);
    expect(ready[1]!.tags).toContainEqual(['tip', rebased]);
    expect(info.mergeTarget).toEqual({
      repo: 'remote/github-scratch',
      branch: 'refs/heads/main',
      tip: rebased,
    });
    // The rewritten feature history reached the remote too — a plain push
    // would have been rejected as a non-fast-forward of the corner's own ref.
    expect(run(worktree, ['ls-remote', remote, 'refs/heads/feature/corner'])).toContain(rebased);
  });

  it('says what is actually happening, and never claims a background retry', async () => {
    const { body, events } = await approvedCornerWithMovedTarget();

    await Reflect.get(body, 'pollDirectRemoteApprovals').call(body);
    await body.waitForAgentTasks();

    const realign = events.find((event) =>
      event.tags.some((tag) => tag[0] === 't' && tag[1] === 'merge-realigning'),
    );
    expect(realign).toBeDefined();
    expect(realign!.tags).toContainEqual(['retry', 'realigning']);
    // The one claim the corner may not make: that something is retrying on its
    // own. It is waiting on a rebase and then on a fresh human approval.
    expect(realign!.content).not.toMatch(/retry|retrying/i);
    expect(realign!.content).toMatch(/fresh review to approve/i);
    // ...and no raw git plumbing reaches the transcript either.
    expect(realign!.content).not.toMatch(/\bgit\b|hint:|non-fast-forward|\[rejected\]/i);
  });

  it('bounds itself: a target that moves again stops and asks the human', async () => {
    const { root, remote, worktree, info, body, events, tip } =
      await approvedCornerWithMovedTarget();

    await Reflect.get(body, 'pollDirectRemoteApprovals').call(body);
    await body.waitForAgentTasks();
    const rebased = run(worktree, ['rev-parse', 'HEAD']);

    // The human approves the rebased tip, and main moves on AGAIN.
    info.humanMergeApproval = { id: 'second-approval', reviewer: 'human-admin', tip: rebased };
    await writeFile(resolve(root, 'AGAIN.md'), 'and again\n');
    run(root, ['add', 'AGAIN.md']);
    run(root, ['commit', '-m', 'target moved on again']);
    run(root, ['push', 'origin', 'main']);
    const movedAgain = run(root, ['ls-remote', remote, 'refs/heads/main']).split(/\s+/)[0]!;

    await Reflect.get(body, 'pollDirectRemoteApprovals').call(body);
    await body.waitForAgentTasks();
    // Second realign is allowed (MAX_CORNER_REALIGN_ATTEMPTS = 2)...
    const secondRebase = run(worktree, ['rev-parse', 'HEAD']);
    expect(secondRebase).not.toBe(rebased);

    // ...a third is not: it stops with a plain in-corner message instead.
    info.humanMergeApproval = { id: 'third-approval', reviewer: 'human-admin', tip: secondRebase };
    await writeFile(resolve(root, 'THIRD.md'), 'once more\n');
    run(root, ['add', 'THIRD.md']);
    run(root, ['commit', '-m', 'target moved on a third time']);
    run(root, ['push', 'origin', 'main']);
    await Reflect.get(body, 'pollDirectRemoteApprovals').call(body);
    await body.waitForAgentTasks();

    expect(run(worktree, ['rev-parse', 'HEAD'])).toBe(secondRebase);
    const blocked = events.filter((event) =>
      event.tags.some((tag) => tag[0] === 'retry' && tag[1] === 'blocked'),
    );
    expect(blocked).toHaveLength(1);
    expect(blocked[0]!.content).toContain('feature/corner');
    expect(blocked[0]!.content).toMatch(/nothing is retrying on its own/i);
    // Nothing this corner ever prepared reached the protected branch.
    const mainNow = run(root, ['ls-remote', remote, 'refs/heads/main']).split(/\s+/)[0]!;
    expect(mainNow).not.toBe(tip);
    expect(mainNow).not.toBe(rebased);
    expect(mainNow).not.toBe(secondRebase);
    expect(run(root, ['merge-base', '--is-ancestor', movedAgain, mainNow])).toBe('');
  });

  it('keeps the automatic-retry claim for a failure the land poll really does re-attempt', async () => {
    const { info, body } = await repository();
    const events = captureEvents();
    const tip = run(info.worktreePath, ['rev-parse', 'HEAD']);
    await expect(publish(body, info)).resolves.toBe(true);
    info.humanMergeApproval = { id: 'approval', reviewer: 'human-admin', tip };
    vi.spyOn(body as never, 'findHumanMergeApproval' as never).mockResolvedValue(
      info.humanMergeApproval as never,
    );
    // A land failure that is NOT a moved target: the remote's own branch rules
    // decline the push. The land poll re-attempts this on every tick, so the
    // automatic-retry claim is honest here and must survive.
    const hook = resolve(info.boundRepo!.localPath!, '..', 'remote.git', 'hooks', 'pre-receive');
    await writeFile(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 });

    await expect(Reflect.get(body, 'pollDirectRemoteApprovals').call(body)).resolves.toBe(0);

    const failure = events.find(
      (event) =>
        event.tags.some((tag) => tag[0] === 'status' && tag[1] === 'failed') &&
        event.content.startsWith("Couldn't land the approved change"),
    );
    expect(failure).toBeDefined();
    expect(failure!.tags).toContainEqual(['retry', 'auto']);
  });
});

describe('preview deployment URL on the review card', () => {
  function mergeReadyTags(events: NostrEvent[]): string[][] {
    return (
      events.find((event) => event.tags.some((tag) => tag[0] === 't' && tag[1] === 'merge-ready'))
        ?.tags ?? []
    );
  }

  it('publishes no preview tag when the origin is not a host with a checks API', async () => {
    const { info, body } = await repository();
    const events = captureEvents();
    // A live fetch here would be a bug: the local origin never reaches a host.
    await expect(publish(body, info)).resolves.toBe(true);
    expect(mergeReadyTags(events).map((tag) => tag[0])).not.toContain('preview');
  });

  it('carries the preview URL of the pushed tip when the host published one', async () => {
    const { worktree, info, body } = await repository();
    // The fetch URL names GitHub (what the checks lookup reads) while the push
    // still goes to the local bare remote.
    const pushUrl = run(worktree, ['remote', 'get-url', 'origin']);
    run(worktree, ['remote', 'set-url', 'origin', 'https://github.com/lunchboxfortwo/scratch.git']);
    run(worktree, ['remote', 'set-url', '--push', 'origin', pushUrl]);
    const tip = run(worktree, ['rev-parse', 'HEAD']);

    const events: NostrEvent[] = [];
    const seen: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.startsWith('https://api.github.com/')) {
          seen.push(url);
          return new Response(
            JSON.stringify({
              statuses: [
                { context: 'ci/tests', state: 'success', target_url: 'https://ci.example/run/9' },
                {
                  context: 'vercel',
                  state: 'success',
                  description: 'Deployment has completed',
                  target_url: 'https://scratch-git-feature-corner.vercel.app',
                },
              ],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        events.push(JSON.parse(String(init?.body)) as NostrEvent);
        return new Response(JSON.stringify({ accepted: true }), { status: 200 });
      }),
    );

    await expect(publish(body, info)).resolves.toBe(true);
    expect(seen[0]).toBe(
      `https://api.github.com/repos/lunchboxfortwo/scratch/commits/${tip}/status`,
    );
    expect(mergeReadyTags(events)).toContainEqual([
      'preview',
      'https://scratch-git-feature-corner.vercel.app',
    ]);
  });

  it('still publishes merge-ready when the preview lookup fails outright', async () => {
    const { worktree, info, body } = await repository();
    const pushUrl = run(worktree, ['remote', 'get-url', 'origin']);
    run(worktree, ['remote', 'set-url', 'origin', 'https://github.com/lunchboxfortwo/scratch.git']);
    run(worktree, ['remote', 'set-url', '--push', 'origin', pushUrl]);

    const events: NostrEvent[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).startsWith('https://api.github.com/')) throw new Error('rate limited');
        events.push(JSON.parse(String(init?.body)) as NostrEvent);
        return new Response(JSON.stringify({ accepted: true }), { status: 200 });
      }),
    );

    await expect(publish(body, info)).resolves.toBe(true);
    expect(mergeReadyTags(events).map((tag) => tag[0])).not.toContain('preview');
  });
});
