import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { AcpClient } from './acp.js';
import { Body, LANDED_TAG, type SubchannelInfo } from './body.js';
import { mediaUploadResponse, relayQueryResponse } from './relay-test-helper.js';
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
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const queryResponse = relayQueryResponse(events, input, init);
      if (queryResponse) return queryResponse;
      const upload = mediaUploadResponse(input, init);
      if (upload) return upload;
      const event = JSON.parse(String(init?.body)) as NostrEvent;
      if (Array.isArray(event.tags)) events.push(event);
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
    // The attention-transition gate also POSTs /query reads through this
    // capture; only signed kind:9 events are publishes.
    const publishes = events.filter((event) => Array.isArray(event.tags));
    expect(
      publishes.some((event) =>
        event.tags.some((tag) => tag[0] === 't' && tag[1] === 'merge-ready'),
      ),
    ).toBe(false);
    expect(
      publishes.some((event) =>
        event.tags.some((tag) => tag[0] === 't' && tag[1] === 'merge-not-ready'),
      ),
    ).toBe(false);
  });

  it('keeps a stale review mounted without a Codex turn before merge is pressed', async () => {
    const { root, worktree, info, body } = await repository();
    const events = captureEvents();
    const featureBefore = run(worktree, ['rev-parse', 'HEAD']);
    await writeFile(resolve(root, 'TARGET.md'), 'new target work\n');
    run(root, ['add', 'TARGET.md']);
    run(root, ['commit', '-m', 'advance target before review']);
    const targetTip = run(root, ['rev-parse', 'HEAD']);
    run(root, ['push', 'origin', 'main']);
    const syncTurn = vi.spyOn(body as never, 'promptAgent' as never);

    await expect(publish(body, info)).resolves.toBe(true);
    expect(syncTurn).not.toHaveBeenCalled();
    expect(info.mergeTarget).toBeDefined();
    expect(info.mergeTarget!.tip).toBe(featureBefore);
    expect(() =>
      run(worktree, ['merge-base', '--is-ancestor', targetTip, info.mergeTarget!.tip]),
    ).toThrow();
    expect(
      events.filter((event) =>
        event.tags.some((tag) => tag[0] === 't' && tag[1] === 'merge-ready'),
      ),
    ).toHaveLength(1);
    expect(
      events.some((event) =>
        event.tags.some((tag) => tag[0] === 't' && tag[1] === 'merge-not-ready'),
      ),
    ).toBe(false);
  });

  it('republishes a rewritten feature ref after restart from remote git truth', async () => {
    const { root, remote, worktree, info, body } = await repository();
    const events = captureEvents();

    await expect(publish(body, info)).resolves.toBe(true);
    const originalFeatureTip = run(worktree, ['rev-parse', 'HEAD']);
    expect(run(worktree, ['ls-remote', remote, 'refs/heads/feature/corner'])).toContain(
      originalFeatureTip,
    );

    await writeFile(resolve(root, 'TARGET.md'), 'main advanced while the daemon was down\n');
    run(root, ['add', 'TARGET.md']);
    run(root, ['commit', '-m', 'advance main during restart']);
    run(root, ['push', 'origin', 'main']);
    run(worktree, ['fetch', 'origin', 'main']);
    run(worktree, ['rebase', 'origin/main']);
    const rewrittenTip = run(worktree, ['rev-parse', 'HEAD']);
    expect(rewrittenTip).not.toBe(originalFeatureTip);

    const restartedBody = new Body({
      agentBinary: '/bin/false',
      mcpBinary: '/bin/false',
      agentEnv: {},
      workspaceRoot: resolve(root, '..'),
      relayBaseUrl: 'http://relay.test',
      relayHost: 'relay.test',
      relayScheme: 'http',
      relayWsUrl: 'ws://relay.test',
      autoApprovePermissions: true,
    });
    const restartedInfo: SubchannelInfo = {
      subchannelId: info.subchannelId,
      worktreePath: info.worktreePath,
      featureBranch: info.featureBranch,
      role: restartedBody.agent,
      session: info.session,
      lastPolledAt: 0,
      archived: false,
      boundRepo: info.boundRepo,
    };
    restartedBody.registerSubchannel(restartedInfo);
    const modelTurn = vi.spyOn(restartedBody as never, 'promptAgent' as never);

    await expect(publish(restartedBody, restartedInfo)).resolves.toBe(true);

    expect(modelTurn).not.toHaveBeenCalled();
    expect(restartedInfo.mergeTarget?.tip).toBe(rewrittenTip);
    expect(run(worktree, ['ls-remote', remote, 'refs/heads/feature/corner'])).toContain(rewrittenTip);
    expect(
      events.filter((event) =>
        event.tags.some((tag) => tag[0] === 't' && tag[1] === 'merge-ready'),
      ),
    ).toHaveLength(2);
  });

  it('publishes one review-delivery failure card for repeated identical failures', async () => {
    const { info, body } = await repository();
    const events = captureEvents();
    info.boundRepo = { ...info.boundRepo!, remoteName: 'missing-remote' };

    await expect(publish(body, info)).resolves.toBe(false);
    await expect(publish(body, info)).resolves.toBe(false);

    const failures = events.filter(
      (event) =>
        event.content.startsWith("Couldn't prepare this change for review:") &&
        event.tags.some((tag) => tag[0] === 'status' && tag[1] === 'failed'),
    );
    expect(failures).toHaveLength(1);
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
      patchId: expect.stringMatching(/^[0-9a-f]{40}$/),
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
      events.find((event) =>
        event.tags.some((tag) => tag[0] === 't' && tag[1] === 'land-summary'),
      ),
    ).toBeDefined();
  });
});

describe('a moved target is standing authorization to update the feature branch', () => {
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

    info.humanMergeApproval = {
      id: 'signed-human-approval',
      reviewer: 'human-admin',
      tip,
      approvedTip: tip,
      patchId: info.mergeTarget?.patchId,
    };
    vi.spyOn(body as never, 'findHumanMergeApproval' as never).mockResolvedValue(
      info.humanMergeApproval as never,
    );
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

  it('uses one Codex sync turn and lands with the standing approval', async () => {
    const { root, remote, worktree, info, body, events, tip, moved, prompts } =
      await approvedCornerWithMovedTarget();

    await expect(Reflect.get(body, 'pollDirectRemoteApprovals').call(body)).resolves.toBe(1);

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain(`main moved to ${moved}`);
    expect(prompts[0]).toMatch(
      /bring this branch up to date and make it land, whatever it takes/i,
    );
    const refreshedTip = run(worktree, ['rev-parse', 'HEAD']);
    expect(refreshedTip).not.toBe(tip);
    expect(run(worktree, ['merge-base', '--is-ancestor', moved, refreshedTip])).toBe('');
    expect(info.mergeTarget?.tip).toBe(refreshedTip);
    expect(info.humanMergeApproval).toMatchObject({
      id: 'signed-human-approval',
      approvedTip: tip,
    });

    // Rewritten work gets a new content-addressed review card and lands under
    // the one standing approval without a second timer or tap.
    // Only signed kind:9 publishes count — the attention-transition gate also
    // POSTs /query reads through this capture.
    const ready = events
      .filter((event) => Array.isArray(event.tags))
      .filter((event) => event.tags.some((tag) => tag[0] === 't' && tag[1] === 'merge-ready'));
    expect(ready).toHaveLength(2);
    expect(run(worktree, ['ls-remote', remote, 'refs/heads/feature/corner'])).toContain(
      refreshedTip,
    );
    expect(run(root, ['ls-remote', remote, 'refs/heads/main'])).toContain(refreshedTip);
    // This one test performs two complete realign-and-land cycles with real
    // Git children. Under full-suite contention it can legitimately exceed
    // the package's ordinary 15s unit boundary while still finishing in ~5s alone.
  }, 30_000);

  it('truthfully reports the automatic recovery without exposing git plumbing', async () => {
    const { body, events } = await approvedCornerWithMovedTarget();

    await Reflect.get(body, 'pollDirectRemoteApprovals').call(body);
    await body.waitForAgentTasks();

    const recovering = events.find(
      (event) =>
        event.tags.some((tag) => tag[0] === 't' && tag[1] === 'agent-activity') &&
        event.tags.some((tag) => tag[0] === 'delivery-stage' && tag[1] === 'realigning'),
    );
    expect(recovering).toBeDefined();
    expect(recovering!.content).toMatch(/Realigning/);
    // No raw git plumbing reaches the transcript activity row.
    expect(recovering!.content).not.toMatch(/\bgit\b|hint:|non-fast-forward|\[rejected\]/i);
  });

  it('starts exactly one synchronization turn for one button press', async () => {
    const { body, events, prompts } = await approvedCornerWithMovedTarget();
    await Reflect.get(body, 'pollDirectRemoteApprovals').call(body);
    await Reflect.get(body, 'pollDirectRemoteApprovals').call(body);
    await Reflect.get(body, 'pollDirectRemoteApprovals').call(body);
    expect(prompts).toHaveLength(1);
    const recovering = events
      .filter((event) => Array.isArray(event.tags))
      .filter(
        (event) =>
          event.tags.some((tag) => tag[0] === 't' && tag[1] === 'agent-activity') &&
          event.tags.some((tag) => tag[0] === 'delivery-stage' && tag[1] === 'realigning'),
      );
    expect(recovering).toHaveLength(2); // in-progress, then completed
  });

  it('parks a failed approval without claiming an automatic retry', async () => {
    const { info, body } = await repository();
    const events = captureEvents();
    const tip = run(info.worktreePath, ['rev-parse', 'HEAD']);
    await expect(publish(body, info)).resolves.toBe(true);
    info.humanMergeApproval = { id: 'approval', reviewer: 'human-admin', tip };
    vi.spyOn(body as never, 'findHumanMergeApproval' as never).mockResolvedValue(
      info.humanMergeApproval as never,
    );
    // A land failure that is NOT a moved target: the remote's own branch rules
    // decline the push. This exact approval must park until a new press.
    const hook = resolve(info.boundRepo!.localPath!, '..', 'remote.git', 'hooks', 'pre-receive');
    await writeFile(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 });

    await expect(Reflect.get(body, 'pollDirectRemoteApprovals').call(body)).resolves.toBe(0);

    const failure = events.find(
      (event) =>
        event.tags.some((tag) => tag[0] === 't' && tag[1] === 'buzz-rearmed-failure') &&
        event.content.startsWith("Couldn't land:"),
    );
    expect(failure).toBeDefined();
    expect(failure!.tags).toContainEqual(['retry', 'blocked']);
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
        const queryResponse = relayQueryResponse(events, input, init);
        if (queryResponse) return queryResponse;
        const upload = mediaUploadResponse(input, init);
        if (upload) return upload;
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
        const queryResponse = relayQueryResponse(events, input, init);
        if (queryResponse) return queryResponse;
        const upload = mediaUploadResponse(input, init);
        if (upload) return upload;
        events.push(JSON.parse(String(init?.body)) as NostrEvent);
        return new Response(JSON.stringify({ accepted: true }), { status: 200 });
      }),
    );

    await expect(publish(body, info)).resolves.toBe(true);
    expect(mergeReadyTags(events).map((tag) => tag[0])).not.toContain('preview');
  });
});
