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
    agent: ReturnType<typeof newIdentity>,
    body: Body,
    info: ReturnType<typeof cornerInfo>,
    tip: string,
    recap: string,
  ): Promise<void> {
    Reflect.set(body, 'findHumanMergeApproval', async (target: typeof info) => {
      (target as { humanMergeApproval?: unknown }).humanMergeApproval = {
        id: 'approval-1',
        reviewer: newIdentity('land-summary-reviewer').publicKey,
        tip,
      };
      return (target as { humanMergeApproval?: unknown }).humanMergeApproval;
    });
    Reflect.set(body, 'promptAgent', async () => ({ agentText: recap, updates: [] }));
    // Archival is a separate human-authorized effect with its own relay
    // authority reads; this suite is about the recap, not the teardown.
    Reflect.set(body, 'archiveSubchannel', async () => undefined);
    await Reflect.get(body, 'publishMergeReady').call(body, info);
    await Reflect.get(body, 'pollDirectRemoteApprovals').call(body);
    await body.pollMergeCompletions();
  }

  it('posts exactly one agent-authored recap naming objective, what landed, what did not, and the commit', async () => {
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

      await landIt(
        agent,
        body,
        info,
        tip,
        [
          'Set out to add a haiku to the readme.',
          'Landed one commit touching README.md.',
          'Did not touch the build or add tests — the change is prose only.',
        ].join('\n'),
      );

      expect(gitCommand(repoPath, ['rev-parse', 'refs/heads/master'])).toBe(tip);
      const summaries = published.filter((event) =>
        event.tags.some((tag) => tag[0] === 't' && tag[1] === 'land-summary'),
      );
      expect(summaries).toHaveLength(1);
      const summary = summaries[0]!;
      // The agent's own voice, in the PARENT Room — not a corner status card.
      expect(summary.tags).toContainEqual(['h', 'room-local']);
      expect(summary.tags).toContainEqual(['t', 'agent-message']);
      expect(summary.tags).toContainEqual(['subchannel', 'corner-land-summary']);
      expect(summary.tags).toContainEqual(['tip', tip]);
      expect(summary.content).toContain('Set out to add a haiku');
      expect(summary.content).toContain('README.md');
      expect(summary.content).toContain('Did not touch the build');
      expect(summary.content).toContain(`Landed on master at ${tip.slice(0, 12)}.`);
      expect(summary.content.split('\n')).toHaveLength(4);
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
      await landIt(agent, body, info, tip, 'Landed the haiku.');

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

  it('falls back to a deterministic recap rather than losing the record when the agent cannot answer', async () => {
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
      Reflect.set(body, 'promptAgent', async () => {
        throw new Error('ACP session is gone');
      });
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
      Reflect.set(body, 'promptAgent', async () => ({ agentText: 'rebased', updates: [] }));
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
        published.filter((event) =>
          event.tags.some((tag) => tag[0] === 't' && tag[1] === 'land-summary'),
        ),
      ).toHaveLength(0);
      // ...and the refusal itself is the self-healing kind, not a dead end.
      expect(
        published.some((event) =>
          event.tags.some((tag) => tag[0] === 't' && tag[1] === 'merge-realigning'),
        ),
      ).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
