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
