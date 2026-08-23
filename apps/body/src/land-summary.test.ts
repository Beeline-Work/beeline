/**
 * The landed-work recap a corner posts to its PARENT Room.
 *
 * Deliberately its own file, importing nothing this change introduced: every
 * assertion here is on the wire (tag strings, message content) and on already
 * public entry points, so the whole suite runs unchanged against the daemon
 * BEFORE this behaviour existed — where it fails because the Room is simply
 * never told what the corner delivered.
 */
import { describe, it, expect, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Body } from './body.js';
import { newIdentity } from '@beeline/gate';
import type { NostrEvent } from '@beeline/nostr';

describe('a corner that lands says what it delivered, in the parent Room', () => {
  function gitCommand(cwd: string, args: string[]): string {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
    return result.stdout.trim();
  }

  /** A local-only repo (no origin) with one committed change in its corner. */
  function localCorner(): { root: string; repoPath: string; cornerPath: string; tip: string } {
    const root = mkdtempSync(join(tmpdir(), 'buzzy-land-summary-'));
    const repoPath = join(root, 'repo');
    const cornerPath = join(root, 'corner');
    mkdirSync(repoPath, { recursive: true });
    gitCommand(repoPath, ['init', '-b', 'master']);
    gitCommand(repoPath, ['config', 'user.name', 'Land Summary Test']);
    gitCommand(repoPath, ['config', 'user.email', 'land-summary@test.invalid']);
    writeFileSync(join(repoPath, 'README.md'), '# Before\n');
    gitCommand(repoPath, ['add', '.']);
    gitCommand(repoPath, ['commit', '-m', 'base']);
    gitCommand(repoPath, ['worktree', 'add', '-b', 'feature/haiku', cornerPath, 'master']);
    gitCommand(cornerPath, ['config', 'user.name', 'Land Summary Agent']);
    gitCommand(cornerPath, ['config', 'user.email', 'agent@test.invalid']);
    writeFileSync(join(cornerPath, 'README.md'), '# Before\n\nan old silent pond\n');
    gitCommand(cornerPath, ['add', 'README.md']);
    gitCommand(cornerPath, ['commit', '-m', 'add a haiku']);
    return { root, repoPath, cornerPath, tip: gitCommand(cornerPath, ['rev-parse', 'HEAD']) };
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

  function cornerInfo(
    agent: ReturnType<typeof newIdentity>,
    repoPath: string,
    cornerPath: string,
  ) {
    return {
      subchannelId: 'corner-land-summary',
      worktreePath: cornerPath,
      featureBranch: 'feature/haiku',
      role: agent,
      session: {
        channelId: 'corner-land-summary',
        parentChannelId: 'room-local',
        sessionId: 'session',
      } as never,
      lastPolledAt: 0,
      archived: false,
      request: {
        eventId: 'req-1',
        authorPubkey: 'human',
        content: '@lena open a corner and add a haiku to the readme',
        createdAt: 1,
      },
      boundRepo: {
        repo: 'proj',
        repositoryKey: 'local-key',
        localOnly: true,
        localPath: repoPath,
        targetBranch: 'refs/heads/master',
      },
    };
  }

  /** Approve + land the corner, exactly as the maintenance tick does. */
  async function landIt(
    body: Body,
    info: ReturnType<typeof cornerInfo>,
    tip: string,
  ): Promise<void> {
    Reflect.set(body, 'findHumanMergeApproval', async (target: typeof info) => {
      (target as { humanMergeApproval?: unknown }).humanMergeApproval = {
        id: 'approval-1',
        reviewer: newIdentity('land-summary-reviewer').publicKey,
        tip,
      };
      return (target as { humanMergeApproval?: unknown }).humanMergeApproval;
    });
    Reflect.set(
      body,
      'promptAgent',
      vi.fn(async () => {
        throw new Error('land recap must not start a model turn');
      }),
    );
    // Archival is a separate human-authorized effect with its own relay
    // authority reads; this suite is about the recap, not the teardown.
    Reflect.set(body, 'archiveSubchannel', async () => undefined);
    await Reflect.get(body, 'publishMergeReady').call(body, info);
    await Reflect.get(body, 'pollDirectRemoteApprovals').call(body);
    await body.pollMergeCompletions();
  }

  it('posts exactly one deterministic recap without starting a model turn', async () => {
    const agent = newIdentity('land-summary-agent');
    const { root, repoPath, cornerPath, tip } = localCorner();
    const published: NostrEvent[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        published.push(JSON.parse(String(init?.body)) as NostrEvent);
        return new Response(JSON.stringify({ accepted: true }), { status: 200 });
      }),
    );
    try {
      const body = newBody(agent, join(root, 'state.json'));
      const info = cornerInfo(agent, repoPath, cornerPath);
      body.registerSubchannel(info as never);

      await landIt(body, info, tip);

      expect(gitCommand(repoPath, ['rev-parse', 'refs/heads/master'])).toBe(tip);
      const summaries = published.filter((event) =>
        event.tags.some((tag) => tag[0] === 't' && tag[1] === 'land-summary'),
      );
      expect(summaries).toHaveLength(1);
      const summary = summaries[0]!;
      // Host-derived facts in the PARENT Room — not a corner status card.
      expect(summary.tags).toContainEqual(['h', 'room-local']);
      expect(summary.tags).toContainEqual(['t', 'agent-message']);
      expect(summary.tags).toContainEqual(['subchannel', 'corner-land-summary']);
      expect(summary.tags).toContainEqual(['tip', tip]);
      expect(summary.content).toBe(
        [
          'Set out to: add a haiku to the readme',
          'Landed: 1 commit across 1 file (README.md).',
          `Landed on master at ${tip.slice(0, 12)}.`,
        ].join('\n'),
      );
      expect(Reflect.get(body, 'promptAgent')).not.toHaveBeenCalled();
      expect(summary.content.split('\n')).toHaveLength(3);
      expect(summary.content.split('\n').length).toBeLessThanOrEqual(8);
      // No raw plumbing survives into a Room a person reads on their phone.
      expect(summary.content).not.toMatch(/\bgit\b|hint:|```/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('never posts a second recap, however many times the completion poll runs', async () => {
    const agent = newIdentity('land-summary-once');
    const { root, repoPath, cornerPath, tip } = localCorner();
    const published: NostrEvent[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        published.push(JSON.parse(String(init?.body)) as NostrEvent);
        return new Response(JSON.stringify({ accepted: true }), { status: 200 });
      }),
    );
    try {
      const body = newBody(agent, join(root, 'state.json'));
      const info = cornerInfo(agent, repoPath, cornerPath);
      body.registerSubchannel(info as never);
      await landIt(body, info, tip);

      await body.pollMergeCompletions();
      await body.pollMergeCompletions();

      expect(
        published.filter((event) =>
          event.tags.some((tag) => tag[0] === 't' && tag[1] === 'land-summary'),
        ),
      ).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('uses deterministic facts even when a corner session is unavailable', async () => {
    const agent = newIdentity('land-summary-fallback');
    const { root, repoPath, cornerPath, tip } = localCorner();
    const published: NostrEvent[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        published.push(JSON.parse(String(init?.body)) as NostrEvent);
        return new Response(JSON.stringify({ accepted: true }), { status: 200 });
      }),
    );
    try {
      const body = newBody(agent, join(root, 'state.json'));
      const info = cornerInfo(agent, repoPath, cornerPath);
      body.registerSubchannel(info as never);
      Reflect.set(body, 'findHumanMergeApproval', async (target: typeof info) => {
        (target as { humanMergeApproval?: unknown }).humanMergeApproval = {
          id: 'approval-1',
          reviewer: newIdentity('land-summary-reviewer-2').publicKey,
          tip,
        };
        return (target as { humanMergeApproval?: unknown }).humanMergeApproval;
      });
      Reflect.set(body, 'archiveSubchannel', async () => undefined);
      Reflect.set(
        body,
        'promptAgent',
        vi.fn(async () => {
          throw new Error('ACP session is gone');
        }),
      );
      await Reflect.get(body, 'publishMergeReady').call(body, info);
      await Reflect.get(body, 'pollDirectRemoteApprovals').call(body);
      await body.pollMergeCompletions();

      const summary = published.find((event) =>
        event.tags.some((tag) => tag[0] === 't' && tag[1] === 'land-summary'),
      );
      expect(summary).toBeDefined();
      expect(summary!.content).toContain('add a haiku to the readme');
      expect(summary!.content).toContain('1 commit across 1 file (README.md)');
      expect(summary!.content).toContain(`Landed on master at ${tip.slice(0, 12)}.`);
      expect(Reflect.get(body, 'promptAgent')).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('posts no recap for a land that failed', async () => {
    const agent = newIdentity('land-summary-failed');
    const { root, repoPath, cornerPath, tip } = localCorner();
    const published: NostrEvent[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        published.push(JSON.parse(String(init?.body)) as NostrEvent);
        return new Response(JSON.stringify({ accepted: true }), { status: 200 });
      }),
    );
    try {
      const body = newBody(agent, join(root, 'state.json'));
      const info = cornerInfo(agent, repoPath, cornerPath);
      body.registerSubchannel(info as never);
      Reflect.set(body, 'findHumanMergeApproval', async (target: typeof info) => {
        (target as { humanMergeApproval?: unknown }).humanMergeApproval = {
          id: 'approval-1',
          reviewer: newIdentity('land-summary-reviewer-3').publicKey,
          tip,
        };
        return (target as { humanMergeApproval?: unknown }).humanMergeApproval;
      });
      Reflect.set(body, 'promptAgent', vi.fn());
      await Reflect.get(body, 'publishMergeReady').call(body, info);
      // master moves on after the human approved this exact tip: the land is
      // refused, so nothing landed and nothing may be reported as landed.
      writeFileSync(join(repoPath, 'OTHER.md'), 'someone else landed first\n');
      gitCommand(repoPath, ['add', 'OTHER.md']);
      gitCommand(repoPath, ['commit', '-m', 'target moved on']);

      await Reflect.get(body, 'pollDirectRemoteApprovals').call(body);
      await body.waitForAgentTasks();
      await body.pollMergeCompletions();

      expect(
        published.filter(
          (event) =>
            Array.isArray(event.tags) &&
            event.tags.some((tag) => tag[0] === 't' && tag[1] === 'land-summary'),
        ),
      ).toHaveLength(0);
      // A moved target self-heals: maintenance reports it as an AUTOMATIC
      // recovery and hands the corner its own target-sync model turn.
      const recovering = published.find(
        (event) =>
          Array.isArray(event.tags) &&
          event.content.startsWith("Couldn't land this change") &&
          event.tags.some((tag) => tag[0] === 'retry' && tag[1] === 'auto'),
      );
      expect(recovering).toBeDefined();
      expect(Reflect.get(body, 'promptAgent')).toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/**
 * The recap used to be posted from ONE place — `pollMergeCompletions` — which
 * re-derives the land from `info.mergeTarget` rather than being told about it.
 * That is the exact state landing destroys: once the target branch holds the
 * corner's work, `publishMergeReady` (run at the tail of every corner turn)
 * finds nothing left to review and withdraws the target, after which every
 * later poll skips the corner entirely. A corner that genuinely landed then
 * never got a recap, a merge summary, or an archive.
 *
 * These walk the live shape that missed: a localOnly repo, an approval, and
 * the daemon's own fast-forward land.
 */
describe('every land path recaps the corner exactly once', () => {
  function gitCommand(cwd: string, args: string[]): string {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
    return result.stdout.trim();
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

  /** A repo with NO remote at all, plus a corner worktree holding one commit. */
  function localOnlyCorner(): {
    root: string;
    repoPath: string;
    cornerPath: string;
    tip: string;
  } {
    const root = mkdtempSync(join(tmpdir(), 'buzzy-land-paths-'));
    const repoPath = join(root, 'repo');
    const cornerPath = join(root, 'corner');
    mkdirSync(repoPath, { recursive: true });
    gitCommand(repoPath, ['init', '-b', 'master']);
    gitCommand(repoPath, ['config', 'user.name', 'Land Paths Test']);
    gitCommand(repoPath, ['config', 'user.email', 'land-paths@test.invalid']);
    writeFileSync(join(repoPath, 'README.md'), '# Before\n');
    gitCommand(repoPath, ['add', '.']);
    gitCommand(repoPath, ['commit', '-m', 'base']);
    gitCommand(repoPath, ['worktree', 'add', '-b', 'feature/haiku', cornerPath, 'master']);
    writeFileSync(join(cornerPath, 'README.md'), '# Before\n\nan old silent pond\n');
    gitCommand(cornerPath, ['add', 'README.md']);
    gitCommand(cornerPath, ['commit', '-m', 'add a haiku']);
    return { root, repoPath, cornerPath, tip: gitCommand(cornerPath, ['rev-parse', 'HEAD']) };
  }

  function cornerInfo(
    agent: ReturnType<typeof newIdentity>,
    repoPath: string,
    cornerPath: string,
    boundRepo: Record<string, unknown>,
  ) {
    return {
      subchannelId: 'corner-land-paths',
      worktreePath: cornerPath,
      featureBranch: 'feature/haiku',
      role: agent,
      session: {
        channelId: 'corner-land-paths',
        parentChannelId: 'room-local',
        sessionId: 'session',
      } as never,
      lastPolledAt: 0,
      archived: false,
      request: {
        eventId: 'req-1',
        authorPubkey: 'human',
        content: '@lena open a corner and add a haiku to the readme',
        createdAt: 1,
      },
      boundRepo: { repo: 'proj', repositoryKey: 'local-key', localPath: repoPath, ...boundRepo },
    };
  }

  function capturePublishes(): NostrEvent[] {
    const published: NostrEvent[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        published.push(JSON.parse(String(init?.body)) as NostrEvent);
        return new Response(JSON.stringify({ accepted: true }), { status: 200 });
      }),
    );
    return published;
  }

  function landSummaries(published: NostrEvent[]): NostrEvent[] {
    // The attention-transition gate also POSTs /query reads through this
    // capture; only signed kind:9 events are publishes.
    return published
      .filter((event) => Array.isArray(event.tags))
      .filter((event) => event.tags.some((tag) => tag[0] === 't' && tag[1] === 'land-summary'));
  }

  /** Approve the corner's exact tip, as a device-held human admin would. */
  function approve(body: Body, tip: string): void {
    Reflect.set(body, 'findHumanMergeApproval', async (target: { humanMergeApproval?: unknown }) => {
      target.humanMergeApproval = {
        id: 'approval-1',
        reviewer: newIdentity('land-paths-reviewer').publicKey,
        tip,
      };
      return target.humanMergeApproval;
    });
    Reflect.set(
      body,
      'promptAgent',
      vi.fn(async () => {
        throw new Error('land recap must not start a model turn');
      }),
    );
  }

  it('recaps a local-only fast-forward land from the land itself, with no completion poll', async () => {
    const agent = newIdentity('land-paths-local');
    const { root, repoPath, cornerPath, tip } = localOnlyCorner();
    const published = capturePublishes();
    try {
      const body = newBody(agent, join(root, 'state.json'));
      const info = cornerInfo(agent, repoPath, cornerPath, {
        localOnly: true,
        targetBranch: 'refs/heads/master',
      });
      body.registerSubchannel(info as never);
      approve(body, tip);

      await Reflect.get(body, 'publishMergeReady').call(body, info);
      // The one poll the live tick ran before the recap went missing.
      const landed = await Reflect.get(body, 'pollDirectRemoteApprovals').call(body);

      expect(landed).toBe(1);
      expect(gitCommand(repoPath, ['rev-parse', 'refs/heads/master'])).toBe(tip);
      const summaries = landSummaries(published);
      expect(summaries).toHaveLength(1);
      expect(summaries[0]!.tags).toContainEqual(['h', 'room-local']);
      expect(summaries[0]!.tags).toContainEqual(['subchannel', 'corner-land-paths']);
      expect(summaries[0]!.tags).toContainEqual(['tip', tip]);
      expect(summaries[0]!.content).toContain('Set out to: add a haiku to the readme');
      expect(summaries[0]!.content).toContain(`Landed on master at ${tip.slice(0, 12)}.`);
      expect(Reflect.get(body, 'promptAgent')).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('still recaps and archives when the land withdraws the corner own merge target', async () => {
    const agent = newIdentity('land-paths-withdrawn');
    const { root, repoPath, cornerPath, tip } = localOnlyCorner();
    const published = capturePublishes();
    const archived: string[] = [];
    try {
      const body = newBody(agent, join(root, 'state.json'));
      const info = cornerInfo(agent, repoPath, cornerPath, {
        localOnly: true,
        targetBranch: 'refs/heads/master',
      });
      body.registerSubchannel(info as never);
      approve(body, tip);
      Reflect.set(body, 'archiveSubchannel', async (id: string) => {
        archived.push(id);
      });

      await Reflect.get(body, 'publishMergeReady').call(body, info);
      await Reflect.get(body, 'pollDirectRemoteApprovals').call(body);
      // The tail of the very next corner turn. master now holds the corner's
      // work, so there is nothing left to review and the approvable target is
      // withdrawn — the state that used to make the recap unreachable.
      await Reflect.get(body, 'publishMergeReady').call(body, info);
      expect(info.mergeTarget).toBeUndefined();
      expect(
        published.some((event) =>
          event.tags.some((tag) => tag[0] === 't' && tag[1] === 'merge-not-ready'),
        ),
      ).toBe(true);

      await body.pollMergeCompletions();

      expect(landSummaries(published)).toHaveLength(1);
      // ...and the landed corner is still torn down, not stranded open.
      expect(archived).toEqual(['corner-land-paths']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('recaps a direct-remote push land from the land itself', async () => {
    const agent = newIdentity('land-paths-remote');
    const { root, repoPath, cornerPath, tip } = localOnlyCorner();
    const published = capturePublishes();
    try {
      const originPath = join(root, 'origin.git');
      gitCommand(root, ['init', '--bare', '-b', 'master', originPath]);
      gitCommand(repoPath, ['remote', 'add', 'origin', originPath]);
      gitCommand(repoPath, ['push', 'origin', 'master']);
      // The agent's completion path is only ever allowed to publish its own
      // feature ref; the land is what advances the protected one.
      gitCommand(cornerPath, ['push', 'origin', 'feature/haiku']);

      const body = newBody(agent, join(root, 'state.json'));
      const info = cornerInfo(agent, repoPath, cornerPath, {
        remoteName: 'origin',
        targetBranch: 'refs/heads/master',
      });
      body.registerSubchannel(info as never);
      approve(body, tip);

      await Reflect.get(body, 'publishMergeReady').call(body, info);
      const landed = await Reflect.get(body, 'pollDirectRemoteApprovals').call(body);

      expect(landed).toBe(1);
      expect(gitCommand(originPath, ['rev-parse', 'refs/heads/master'])).toBe(tip);
      expect(landSummaries(published)).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
