/**
 * The landed-work recap, under the conditions the LIVE daemon actually runs in.
 *
 * #255 made the recap fire from the land itself rather than from a later
 * re-derivation of it, and its own suite proves that on a healthy relay with an
 * answering agent. The live miss it was meant to close then happened AGAIN, on
 * the #255 binary: a local-only corner's work fast-forwarded `master`, and the
 * parent Room was never told anything at all.
 *
 * What the tested path and the live path do not share is failure. Every publish
 * in `land-summary.test.ts` returns HTTP 200 and every agent turn answers
 * immediately; live, the same window carried repeated relay/WS churn and an ACP
 * session that was being torn down by the archive that follows a land. These
 * walk that shape:
 *
 *  - a transient relay refusal on one of the two status publishes the land
 *    makes BEFORE the recap, followed by the next corner turn's
 *    `publishMergeReady` withdrawal and the archive;
 *  - a transient refusal of the recap publish itself;
 *  - a recap turn whose session never answers, because the archive already
 *    took it.
 *
 * Deliberately imports nothing this change introduces: every assertion is on
 * the wire and on already-public entry points, so the whole file runs unchanged
 * against the pre-fix daemon — where each case is the silence the Room saw.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Body } from './body.js';
import { newIdentity } from '@beeline/gate';
import { signEvent, type NostrEvent } from '@beeline/nostr';

describe('a landed corner is recapped even when the relay or the session misbehaves', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function gitCommand(cwd: string, args: string[]): string {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
    return result.stdout.trim();
  }

  /** A repository with NO remote at all, plus a corner worktree holding one commit. */
  function localOnlyCorner(): { root: string; repoPath: string; cornerPath: string; tip: string } {
    const root = mkdtempSync(join(tmpdir(), 'buzzy-land-recap-'));
    const repoPath = join(root, 'repo');
    const cornerPath = join(root, 'corner');
    mkdirSync(repoPath, { recursive: true });
    gitCommand(repoPath, ['init', '-b', 'master']);
    gitCommand(repoPath, ['config', 'user.name', 'Land Recap Test']);
    gitCommand(repoPath, ['config', 'user.email', 'land-recap@test.invalid']);
    writeFileSync(join(repoPath, 'README.md'), '# Before\n');
    gitCommand(repoPath, ['add', '.']);
    gitCommand(repoPath, ['commit', '-m', 'base']);
    gitCommand(repoPath, ['worktree', 'add', '-b', 'feature/haiku', cornerPath, 'master']);
    writeFileSync(join(cornerPath, 'README.md'), '# Before\n\nan old silent pond\n');
    gitCommand(cornerPath, ['add', 'README.md']);
    gitCommand(cornerPath, ['commit', '-m', 'title the haiku section three seasons']);
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

  function cornerInfo(agent: ReturnType<typeof newIdentity>, repoPath: string, cornerPath: string) {
    return {
      subchannelId: 'corner-c1a79d53',
      worktreePath: cornerPath,
      featureBranch: 'feature/haiku',
      role: agent,
      session: {
        channelId: 'corner-c1a79d53',
        parentChannelId: 'room-local',
        sessionId: 'session',
      } as never,
      lastPolledAt: 0,
      archived: false,
      request: {
        eventId: 'req-1',
        authorPubkey: 'human',
        content: '@lena open a corner and title the haiku section three seasons',
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

  /**
   * A relay that accepts everything except the events `refuse` picks out — the
   * shape of a transient ingress refusal, which `publishEvent` surfaces to its
   * caller rather than retrying.
   */
  function capturePublishes(
    refuse?: (event: NostrEvent) => boolean,
    queryResults: NostrEvent[] = [],
  ): NostrEvent[] {
    const published: NostrEvent[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith('/query')) {
          return new Response(JSON.stringify(queryResults), { status: 200 });
        }
        const event = JSON.parse(String(init?.body)) as NostrEvent;
        if (refuse?.(event)) {
          return new Response('rate limited, retry in 30s', { status: 429 });
        }
        published.push(event);
        return new Response(JSON.stringify({ accepted: true }), { status: 200 });
      }),
    );
    return published;
  }

  function landSummaries(published: NostrEvent[]): NostrEvent[] {
    return published.filter((event) =>
      event.tags.some((tag) => tag[0] === 't' && tag[1] === 'land-summary'),
    );
  }

  function hasTag(event: NostrEvent, key: string, value: string): boolean {
    return event.tags.some((tag) => tag[0] === key && tag[1] === value);
  }

  /** Approve the corner's exact tip, as a device-held human admin would. */
  function approve(body: Body, tip: string, recap: string): void {
    Reflect.set(body, 'findHumanMergeApproval', async (target: { humanMergeApproval?: unknown }) => {
      target.humanMergeApproval = {
        id: 'approval-1',
        reviewer: newIdentity('land-recap-reviewer').publicKey,
        tip,
      };
      return target.humanMergeApproval;
    });
    Reflect.set(body, 'promptAgent', async () => ({ agentText: recap, updates: [] }));
  }

  /** `pollRoomMaintenance` runs every step behind this guard. */
  async function guarded(run: () => Promise<unknown>): Promise<void> {
    try {
      await run();
    } catch {
      /* the tick logs and retries on the next pass */
    }
  }

  it('recaps a land whose own status card the relay refused, through the withdrawal and archive that follow', async () => {
    const agent = newIdentity('land-recap-churn');
    const { root, repoPath, cornerPath, tip } = localOnlyCorner();
    // The live window's relay churn, aimed at the first publish the land makes
    // after the branch has already moved: the corner's `landed` status card.
    const published = capturePublishes((event) => hasTag(event, 't', 'landed'));
    const archived: string[] = [];
    try {
      const body = newBody(agent, join(root, 'state.json'));
      const info = cornerInfo(agent, repoPath, cornerPath);
      body.registerSubchannel(info as never);
      approve(body, tip, 'Titled the haiku section three seasons. Did not touch the build.');
      Reflect.set(body, 'archiveSubchannel', async (id: string) => {
        archived.push(id);
        (info as { archived: boolean }).archived = true;
      });

      await Reflect.get(body, 'publishMergeReady').call(body, info);
      await guarded(() => Reflect.get(body, 'pollDirectRemoteApprovals').call(body));

      // The land itself really happened — this is not a corner that failed.
      expect(gitCommand(repoPath, ['rev-parse', 'refs/heads/master'])).toBe(tip);

      // The tail of the very next corner turn. `master` now holds the corner's
      // work, so there is nothing left to review and the approvable target is
      // withdrawn — after which no poll can re-derive the land.
      await Reflect.get(body, 'publishMergeReady').call(body, info);
      expect(info.mergeTarget).toBeUndefined();

      await guarded(() => body.pollMergeCompletions());

      const summaries = landSummaries(published);
      expect(summaries).toHaveLength(1);
      expect(summaries[0]!.tags).toContainEqual(['h', 'room-local']);
      expect(summaries[0]!.tags).toContainEqual(['subchannel', 'corner-c1a79d53']);
      expect(summaries[0]!.content).toContain(`Landed on master at ${tip.slice(0, 12)}.`);
      // ...and the landed corner is still torn down, not stranded open.
      expect(archived).toEqual(['corner-c1a79d53']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('re-attempts a recap the relay refused instead of burning it on the first try', async () => {
    const agent = newIdentity('land-recap-refused');
    const { root, repoPath, cornerPath, tip } = localOnlyCorner();
    let refusals = 1;
    const published = capturePublishes((event) => {
      if (!hasTag(event, 't', 'land-summary') || refusals <= 0) return false;
      refusals--;
      return true;
    });
    try {
      const body = newBody(agent, join(root, 'state.json'));
      const info = cornerInfo(agent, repoPath, cornerPath);
      body.registerSubchannel(info as never);
      approve(body, tip, 'Titled the haiku section three seasons.');
      Reflect.set(body, 'archiveSubchannel', async () => undefined);

      await Reflect.get(body, 'publishMergeReady').call(body, info);
      await guarded(() => Reflect.get(body, 'pollDirectRemoteApprovals').call(body));
      expect(landSummaries(published)).toHaveLength(0);

      // The relay recovers. The next maintenance tick must still tell the Room.
      await guarded(() => body.pollMergeCompletions());
      expect(landSummaries(published)).toHaveLength(1);

      // ...and exactly once, however many ticks follow.
      await guarded(() => body.pollMergeCompletions());
      await guarded(() => body.pollMergeCompletions());
      expect(landSummaries(published)).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('recaps a landed corner a human closes before any poll could, at the archive itself', async () => {
    const agent = newIdentity('land-recap-closed');
    const { root, repoPath, cornerPath, tip } = localOnlyCorner();
    // The relay refuses the recap for the whole window the corner is open, so
    // the archive really is its last chance rather than a redundant retry.
    let refusals = 1;
    // The corner's immutable parent link, which the archive re-derives from the
    // relay before it will touch anything.
    const create = signEvent(
      {
        pubkey: agent.publicKey,
        created_at: Math.floor(Date.now() / 1000),
        kind: 9007,
        tags: [
          ['h', 'corner-c1a79d53'],
          ['parent', 'room-local'],
        ],
        content: '',
      },
      agent.secretKey,
    );
    const published = capturePublishes((event) => {
      if (!hasTag(event, 't', 'land-summary') || refusals <= 0) return false;
      refusals--;
      return true;
    }, [create]);
    try {
      const body = newBody(agent, join(root, 'state.json'));
      const info = cornerInfo(agent, repoPath, cornerPath);
      Reflect.set(body, 'agentRelay', { queryEvents: vi.fn(async () => [create]) });
      Reflect.set(body, 'removeWorktree', async () => undefined);
      body.registerSubchannel({
        ...info,
        session: {
          ...(info.session as unknown as Record<string, unknown>),
          mode: 'edit',
          archived: false,
          client: { sessionCancel: () => undefined, stop: async () => undefined },
        },
      } as never);
      const registered = body.getSubchannels().get('corner-c1a79d53') as never as typeof info;
      approve(body, tip, 'Titled the haiku section three seasons.');

      await Reflect.get(body, 'publishMergeReady').call(body, registered);
      await guarded(() => Reflect.get(body, 'pollDirectRemoteApprovals').call(body));
      expect(landSummaries(published)).toHaveLength(0);

      // "■ CLOSE CORNER" — before any completion poll re-attempted the recap.
      await body.archiveSubchannel('corner-c1a79d53');

      expect(body.getSubchannels().has('corner-c1a79d53')).toBe(false);
      const summaries = landSummaries(published);
      expect(summaries).toHaveLength(1);
      expect(summaries[0]!.tags).toContainEqual(['h', 'room-local']);
      expect(summaries[0]!.content).toContain(`Landed on master at ${tip.slice(0, 12)}.`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('recaps on a bounded budget when the corner session never answers', async () => {
    const agent = newIdentity('land-recap-wedged');
    const { root, repoPath, cornerPath, tip } = localOnlyCorner();
    const published = capturePublishes();
    try {
      const body = newBody(agent, join(root, 'state.json'));
      const info = cornerInfo(agent, repoPath, cornerPath);
      body.registerSubchannel(info as never);
      approve(body, tip, 'unused');
      Reflect.set(body, 'archiveSubchannel', async () => undefined);
      // The archive that follows a land takes the ACP session with it. A
      // request left in flight against a stopped backend simply never answers.
      Reflect.set(body, 'promptAgent', () => new Promise(() => {}));

      vi.useFakeTimers();
      let tickFinished = false;
      void Reflect.get(body, 'publishMergeReady')
        .call(body, info)
        .then(() => Reflect.get(body, 'pollDirectRemoteApprovals').call(body))
        .then(() => {
          tickFinished = true;
        });
      // Far past any budget a recap turn could reasonably claim, and well past
      // the whole maintenance tick it is running inside.
      await vi.advanceTimersByTimeAsync(10 * 60_000);

      expect(tickFinished).toBe(true);
      const summaries = landSummaries(published);
      expect(summaries).toHaveLength(1);
      // The deterministic recap, not silence.
      expect(summaries[0]!.content).toContain('title the haiku section three seasons');
      expect(summaries[0]!.content).toContain(`Landed on master at ${tip.slice(0, 12)}.`);
    } finally {
      vi.useRealTimers();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
