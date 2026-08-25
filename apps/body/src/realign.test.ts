/**
 * Post-merge auto-realign (`realign.ts` + the Body wiring).
 *
 * When a merge lands on the target branch, open corners of the same
 * repository must follow WITHOUT their human asking each agent — and a
 * corner that cannot follow (conflict, uncommitted work) must say so
 * plainly instead of silently diverging.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { newIdentity } from '@beeline/gate';
import type { NostrEvent } from '@beeline/nostr';
import { Body } from './body.js';
import {
  realignAnnouncement,
  realignWorktreeOntoTarget,
  summarizeRebaseFailure,
} from './realign.js';

function g(cwd: string, args: string[], ok = true): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (ok && result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

/** A canonical checkout with origin = a local bare remote, plus a linked
 *  corner worktree on a feature branch holding one committed change. */
function repoWithCorner(opts: { conflict?: boolean; dirty?: boolean } = {}): {
  root: string;
  checkoutPath: string;
  cornerPath: string;
  featureTip: () => string;
  advanceMain: (message: string) => string;
} {
  const root = mkdtempSync(join(tmpdir(), 'buzzy-realign-'));
  const originPath = join(root, 'origin.git');
  const checkoutPath = join(root, 'checkout');
  const cornerPath = join(root, 'corner');
  mkdirSync(originPath, { recursive: true });
  g(originPath, ['init', '--bare', '-b', 'master']);
  g(root, ['clone', originPath, checkoutPath]);
  g(checkoutPath, ['config', 'user.name', 'Realign Test']);
  g(checkoutPath, ['config', 'user.email', 'realign@test.invalid']);
  writeFileSync(join(checkoutPath, 'README.md'), '# Base\n');
  g(checkoutPath, ['add', '.']);
  g(checkoutPath, ['commit', '-m', 'base']);
  g(checkoutPath, ['push', 'origin', 'master']);
  g(checkoutPath, ['worktree', 'add', '-b', 'feature/style', cornerPath, 'master']);
  g(cornerPath, ['config', 'user.name', 'Corner Agent']);
  g(cornerPath, ['config', 'user.email', 'agent@test.invalid']);
  if (opts.conflict) {
    // The corner rewrites README.md; main appends to it too → real conflict.
    writeFileSync(join(cornerPath, 'README.md'), '# Rewritten by corner\n');
    g(cornerPath, ['add', '.']);
    g(cornerPath, ['commit', '-m', 'rewrite readme']);
  }
  if (!opts.conflict || true) {
    writeFileSync(join(cornerPath, 'docs.md'), 'corner work\n');
  }
  g(cornerPath, ['add', '.']);
  g(cornerPath, ['commit', '-m', 'corner change']);
  if (opts.dirty) writeFileSync(join(cornerPath, 'scratch.md'), 'uncommitted\n');
  return {
    root,
    checkoutPath,
    cornerPath,
    featureTip: () => g(cornerPath, ['rev-parse', 'HEAD']),
    advanceMain: (message) => {
      g(checkoutPath, ['pull', '--ff-only', 'origin', 'master']);
      const readme = readFileSync(join(checkoutPath, 'README.md'), 'utf8');
      writeFileSync(join(checkoutPath, 'README.md'), `${readme}${message}\n`);
      g(checkoutPath, ['add', '.']);
      g(checkoutPath, ['commit', '-m', message]);
      g(checkoutPath, ['push', 'origin', 'master']);
      return g(checkoutPath, ['rev-parse', 'refs/remotes/origin/master']);
    },
  };
}

function newBody(agent: ReturnType<typeof newIdentity>, statePath: string) {
  return new Body(
    {
      agentBinary: '/nonexistent',
      mcpBinary: '/nonexistent',
      agentEnv: {},
      workspaceRoot: '/workspace',
      relayBaseUrl: 'https://relay.example',
      relayHost: 'relay.example',
      relayScheme: 'https',
      relayWsUrl: 'wss://relay.example',
      autoApprovePermissions: true,
    },
    undefined,
    agent,
    undefined,
    { statePath },
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('realignWorktreeOntoTarget', () => {
  it('rebases a clean corner onto the new target tip via its remote', async () => {
    const { root, cornerPath, advanceMain, featureTip } = repoWithCorner();
    try {
      const before = featureTip();
      const newTip = advanceMain('main moves on');
      const result = await realignWorktreeOntoTarget(cornerPath, {
        remoteName: 'origin',
        targetBranch: 'refs/heads/master',
      });
      expect(result.status).toBe('rebased');
      expect(result.previousTip).toBe(before);
      // The corner's branch now sits on top of the new main.
      expect(g(cornerPath, ['merge-base', '--is-ancestor', newTip, 'HEAD']) !== undefined).toBe(
        true,
      );
      expect(g(cornerPath, ['rev-parse', 'HEAD'])).not.toBe(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports up-to-date without touching an already-current corner', async () => {
    const { root, cornerPath, featureTip } = repoWithCorner();
    try {
      const before = featureTip();
      const result = await realignWorktreeOntoTarget(cornerPath, {
        remoteName: 'origin',
        targetBranch: 'refs/heads/master',
      });
      expect(result.status).toBe('up-to-date');
      expect(g(cornerPath, ['rev-parse', 'HEAD'])).toBe(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('announces instead of diverging when the rebase conflicts, leaving the corner untouched', async () => {
    const { root, cornerPath, advanceMain, featureTip } = repoWithCorner({ conflict: true });
    try {
      advanceMain('main rewrites the same file');
      const before = featureTip();
      const result = await realignWorktreeOntoTarget(cornerPath, {
        remoteName: 'origin',
        targetBranch: 'refs/heads/master',
      });
      expect(result.status).toBe('conflict');
      // The aborted rebase leaves the corner exactly where it was.
      expect(g(cornerPath, ['rev-parse', 'HEAD'])).toBe(before);
      const announcement = realignAnnouncement(result, 'feature/style', 'refs/heads/master');
      expect(announcement).toBeDefined();
      expect(announcement).toContain('conflict');
      expect(announcement).toContain(before.slice(0, 12));
      expect(announcement!.toLowerCase()).not.toMatch(/fatal|hint:/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses to mix uncommitted work into an automatic rebase, and says so', async () => {
    const { root, cornerPath, advanceMain } = repoWithCorner({ dirty: true });
    try {
      advanceMain('main moves while corner is dirty');
      const result = await realignWorktreeOntoTarget(cornerPath, {
        remoteName: 'origin',
        targetBranch: 'refs/heads/master',
      });
      expect(result.status).toBe('dirty');
      const announcement = realignAnnouncement(result, 'feature/style', 'refs/heads/master');
      expect(announcement).toContain('NOT rebased');
      expect(announcement).toContain('uncommitted');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('summarizes conflicting paths from rebase output', () => {
    const summary = summarizeRebaseFailure(
      'CONFLICT (content): Merge conflict in README.md\nAuto-merging docs.md\nCONFLICT (content): Merge conflict in docs.md\n',
    );
    expect(summary).toContain('README.md');
  });
});

describe('Body realigns corners after a land', () => {
  function cornerShaped(
    agent: ReturnType<typeof newIdentity>,
    id: string,
    worktreePath: string,
    repoKey: string,
    extra: Record<string, unknown> = {},
  ) {
    return {
      subchannelId: id,
      worktreePath,
      featureBranch: 'feature/style',
      role: agent,
      session: { channelId: id, parentChannelId: `room-${id}`, sessionId: 's' } as never,
      lastPolledAt: 0,
      archived: false,
      boundRepo: {
        repo: 'proj',
        repositoryKey: repoKey,
        localOnly: false,
        remoteName: 'origin',
        targetBranch: 'refs/heads/master',
      },
      ...extra,
    };
  }

  it('rebases a clean follower and skips a corner whose review is outstanding', async () => {
    const agent = newIdentity('realign-body-agent');
    const repo = repoWithCorner();
    // A second worktree on the same feature branch base, under active review.
    const reviewPath = join(repo.root, 'corner-review');
    g(repo.checkoutPath, ['worktree', 'add', '-b', 'feature/review', reviewPath, 'master']);
    g(reviewPath, ['config', 'user.name', 'Review Agent']);
    g(reviewPath, ['config', 'user.email', 'agent@test.invalid']);
    writeFileSync(join(reviewPath, 'review.md'), 'under review\n');
    g(reviewPath, ['add', '.']);
    g(reviewPath, ['commit', '-m', 'review change']);
    try {
      const newTip = repo.advanceMain('main moves on');
      const reviewBefore = g(reviewPath, ['rev-parse', 'HEAD']);

      const body = newBody(agent, join(repo.root, 'state.json'));
      body.registerSubchannel(
        cornerShaped(agent, 'corner-clean', repo.cornerPath, 'repo-key') as never,
      );
      body.registerSubchannel(
        cornerShaped(agent, 'corner-review', reviewPath, 'repo-key', {
          mergeTarget: { repo: 'r', branch: 'refs/heads/master', tip: 'b'.repeat(40) },
        }) as never,
      );
      const published: NostrEvent[] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
          published.push(JSON.parse(String(init?.body)) as NostrEvent);
          return new Response(JSON.stringify({ accepted: true }), { status: 200 });
        }),
      );

      const rebased = await Reflect.get(body, 'realignCornersForRepo').call(
        body,
        'remote/repo-key',
        'refs/heads/master',
      );

      expect(rebased).toBe(1);
      // The clean follower now descends from the new main.
      expect(g(repo.cornerPath, ['merge-base', '--is-ancestor', newTip, 'HEAD'])).toBeDefined();
      // The under-review corner kept its exact approved tip.
      expect(g(reviewPath, ['rev-parse', 'HEAD'])).toBe(reviewBefore);
      // A quiet success publishes nothing into the transcript.
      expect(
        published.filter((event) =>
          event.tags.some((tag) => tag[0] === 't' && tag[1] === 'corner-realign'),
        ),
      ).toHaveLength(0);
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });

  it('announces a conflicted corner plainly instead of letting it diverge silently', async () => {
    const agent = newIdentity('realign-conflict-agent');
    const repo = repoWithCorner({ conflict: true });
    try {
      repo.advanceMain('main rewrites the same file');
      const before = repo.featureTip();

      const body = newBody(agent, join(repo.root, 'state.json'));
      body.registerSubchannel(
        cornerShaped(agent, 'corner-conflict', repo.cornerPath, 'repo-key') as never,
      );
      const published: NostrEvent[] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
          // Reads (e.g. publishAttentionTransition's fail-open standing-status
          // check) must get an event ARRAY — a JSON error body here would
          // retry three times and land every retry's request body in
          // `published` as a tagless junk entry.
          if (String(input).endsWith('/query')) {
            return new Response(JSON.stringify([]), { status: 200 });
          }
          published.push(JSON.parse(String(init?.body)) as NostrEvent);
          return new Response(JSON.stringify({ accepted: true }), { status: 200 });
        }),
      );

      await Reflect.get(body, 'realignCornersForRepo').call(
        body,
        'remote/repo-key',
        'refs/heads/master',
      );

      const announcements = published.filter((event) =>
        event.tags.some((tag) => tag[0] === 't' && tag[1] === 'corner-realign'),
      );
      expect(announcements.length).toBe(1);
      const announcement = announcements[0]!;
      expect(announcement.tags).toContainEqual(['status', 'failed']);
      expect(announcement.tags).toContainEqual(['display-status', 'needs-attention']);
      expect(announcement.content).toContain('could not be brought up to date');
      expect(announcement.content).toContain(before.slice(0, 12));
      expect(announcement.content.toLowerCase()).not.toMatch(/fatal|hint:/);
      // The abort left the corner exactly where it was.
      expect(g(repo.cornerPath, ['rev-parse', 'HEAD'])).toBe(before);
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });

  it('realigned exactly-once per landed tip via recapLandedCorner hook dedup', async () => {
    const agent = newIdentity('realign-dedup-agent');
    const repo = repoWithCorner();
    try {
      repo.advanceMain('main moves once');
      const body = newBody(agent, join(repo.root, 'state.json'));
      body.registerSubchannel(
        cornerShaped(agent, 'corner-dedup', repo.cornerPath, 'repo-key') as never,
      );
      let calls = 0;
      Reflect.set(body, 'realignCornersForRepo', async () => {
        calls++;
        return 0;
      });
      const info = (
        body as unknown as { subchannels: Map<string, { boundRepo?: unknown }> }
      ).subchannels.get('corner-dedup')!;
      info.boundRepo = info.boundRepo ?? {};
      const hook = Reflect.get(body, 'realignRepositoryAfterLand') as (
        r: unknown,
        t: string,
      ) => Promise<void>;
      await hook.call(
        body,
        { repositoryKey: 'repo-key', targetBranch: 'refs/heads/master' },
        'c'.repeat(40),
      );
      await hook.call(
        body,
        { repositoryKey: 'repo-key', targetBranch: 'refs/heads/master' },
        'c'.repeat(40),
      );
      expect(calls).toBe(1);
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });

  it('applies an owner-confirmed Room branch switch and rebases every open corner', async () => {
    const agent = newIdentity('branch-switch-agent');
    const repo = repoWithCorner();
    try {
      g(repo.checkoutPath, ['checkout', '-b', 'staging']);
      writeFileSync(join(repo.checkoutPath, 'STAGING.md'), 'new canon\n');
      g(repo.checkoutPath, ['add', '.']);
      g(repo.checkoutPath, ['commit', '-m', 'create staging canon']);
      g(repo.checkoutPath, ['push', 'origin', 'staging']);
      const stagingTip = g(repo.checkoutPath, ['rev-parse', 'HEAD']);
      g(repo.checkoutPath, ['checkout', 'master']);

      const body = newBody(agent, join(repo.root, 'state.json'));
      body.registerSubchannel(
        cornerShaped(agent, 'corner-switch', repo.cornerPath, 'repo-key') as never,
      );
      Reflect.set(body, 'currentRoomTargetBranch', async () => 'staging');
      const published: NostrEvent[] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
          if (String(input).endsWith('/query')) {
            return new Response(JSON.stringify([]), { status: 200 });
          }
          published.push(JSON.parse(String(init?.body)) as NostrEvent);
          return new Response(JSON.stringify({ accepted: true }), { status: 200 });
        }),
      );

      await expect(
        Reflect.get(body, 'reconcileRoomTargetBranch').call(body, 'room-corner-switch', {
          repo: 'proj',
          repositoryKey: 'repo-key',
          localOnly: false,
          remoteName: 'origin',
          targetBranch: 'refs/heads/master',
        }),
      ).resolves.toBe(1);

      const info = Reflect.get(body, 'subchannels').get('corner-switch');
      expect(info.boundRepo.targetBranch).toBe('refs/heads/staging');
      expect(info.session.resumeTargetRef).toBe('refs/heads/staging');
      expect(g(repo.cornerPath, ['merge-base', '--is-ancestor', stagingTip, 'HEAD'])).toBeDefined();
      const activity = published.find((event) =>
        event.tags.some((tag) => tag[0] === 't' && tag[1] === 'room-target-branch-realign'),
      );
      expect(activity?.tags).toContainEqual(['t', 'agent-activity']);
      expect(activity?.tags).toContainEqual(['status', 'completed']);
      const envelope = JSON.parse(activity!.content) as {
        update: { sessionUpdate: string; updates: Array<Record<string, unknown>> };
      };
      expect(envelope.update.sessionUpdate).toBe('activity_batch');
      expect(envelope.update.updates[0]).toMatchObject({
        sessionUpdate: 'tool_activity',
        status: 'completed',
      });
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });

  it('surfaces a branch-switch conflict as typed activity and queues one agent resolution turn', async () => {
    const agent = newIdentity('branch-switch-conflict-agent');
    const repo = repoWithCorner({ conflict: true });
    try {
      g(repo.checkoutPath, ['checkout', '-b', 'staging']);
      writeFileSync(join(repo.checkoutPath, 'README.md'), '# Staging canon\n');
      g(repo.checkoutPath, ['add', '.']);
      g(repo.checkoutPath, ['commit', '-m', 'rewrite staging canon']);
      g(repo.checkoutPath, ['push', 'origin', 'staging']);
      g(repo.checkoutPath, ['checkout', 'master']);
      const before = repo.featureTip();

      const body = newBody(agent, join(repo.root, 'state.json'));
      body.registerSubchannel(
        cornerShaped(agent, 'corner-switch-conflict', repo.cornerPath, 'repo-key') as never,
      );
      Reflect.set(body, 'currentRoomTargetBranch', async () => 'staging');
      const published: NostrEvent[] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
          if (String(input).endsWith('/query')) {
            return new Response(JSON.stringify([]), { status: 200 });
          }
          published.push(JSON.parse(String(init?.body)) as NostrEvent);
          return new Response(JSON.stringify({ accepted: true }), { status: 200 });
        }),
      );

      await expect(
        Reflect.get(body, 'reconcileRoomTargetBranch').call(body, 'room-corner-switch-conflict', {
          repo: 'proj',
          repositoryKey: 'repo-key',
          localOnly: false,
          remoteName: 'origin',
          targetBranch: 'refs/heads/master',
        }),
      ).resolves.toBe(0);

      const info = Reflect.get(body, 'subchannels').get('corner-switch-conflict');
      expect(info.boundRepo.targetBranch).toBe('refs/heads/staging');
      expect(g(repo.cornerPath, ['rev-parse', 'HEAD'])).toBe(before);
      expect(Reflect.get(body, 'branchSwitchResolutions').has('corner-switch-conflict')).toBe(true);
      const activity = published.find((event) =>
        event.tags.some((tag) => tag[0] === 't' && tag[1] === 'room-target-branch-realign'),
      );
      expect(activity?.tags).toContainEqual(['t', 'agent-activity']);
      expect(activity?.tags).toContainEqual(['status', 'failed']);
      const update = (
        JSON.parse(activity!.content) as {
          update: { updates: Array<Record<string, unknown>> };
        }
      ).update.updates[0];
      expect(update).toMatchObject({ sessionUpdate: 'tool_activity', status: 'failed' });
      expect(String(update?.output)).toContain('conflict');

      const start = vi
        .spyOn(body as never, 'startAgentTask' as never)
        .mockImplementation(() => undefined as never);
      await Reflect.get(body, 'pollBranchSwitchResolutions').call(body);
      expect(start).toHaveBeenCalledOnce();
      expect(start.mock.calls[0]?.[1]).toContain('Resolve the feature branch onto staging');
      expect(Reflect.get(body, 'branchSwitchResolutions').has('corner-switch-conflict')).toBe(
        false,
      );
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });
});
