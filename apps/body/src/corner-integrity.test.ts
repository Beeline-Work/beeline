/**
 * A corner must not lose work, and must not duplicate it.
 *
 * Every case here is shaped from a trail read off the captain's live Room
 * rather than from what the daemon's own code looked like it did:
 *
 *  - Corner `8731c8ce` carried a human merge approval for tip `df01b054` and
 *    answered it with 100 byte-identical "couldn't land" cards over 100
 *    minutes, then went permanently silent with the approval still valid.
 *  - Five corners were still non-terminal on the relay while their worktrees
 *    AND their feature branches were gone from the serving checkout; the
 *    daemon's only response was to re-publish "could not restore this corner
 *    worktree" once per restart, eight times.
 *  - Two open-a-corner messages fifty seconds apart produced two corners, the
 *    second with no `task` tag at all, re-doing the first one's work.
 *
 * So these tests use real git repositories, real worktrees, and the daemon's
 * real poll entry points. Several of them assert an ORDER or an ABSENCE, which
 * is where the previous round of fixes went wrong: back-to-back unit calls in
 * the happy order proved a chain that the live daemon never executes in that
 * order.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AcpClient } from './acp.js';
import { Body, CORNER_WORKTREE_UNRESTORABLE, type SubchannelInfo } from './body.js';
import {
  cornerWorktreeSweepDecision,
  probeCornerWorktree,
  resolveTargetRefs,
} from './corner-worktree-sweep.js';
import {
  duplicateCornerOpen,
  duplicateCornerOpenRefusal,
  CORNER_OPEN_DUPLICATE_WINDOW_MS,
} from './corner-open-guard.js';
import { taskDescriptionFromCornerRequest } from './body.js';
import type { NostrEvent } from '@beeline/nostr';

const cleanup: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return (result.stdout ?? '').trim();
}

interface Fixture {
  root: string;
  bare: string;
  checkout: string;
  pool: string;
  worktree: string;
  body: Body;
  info: SubchannelInfo;
  tip: string;
}

/**
 * A repository with a real bare remote, a serving checkout, and one corner
 * worktree holding one unlanded commit — the exact geometry of a corner that
 * has published a review and is waiting on an approval.
 *
 * The corner pool sits where `cornersPoolRoot` puts it for a paired checkout:
 * a hidden sibling of the checkout, keyed by repository, with the subchannel id
 * as the directory name.
 */
function corner(subchannelId = 'corner-1'): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'beeline-corner-integrity-'));
  cleanup.push(root);
  const bare = resolve(root, 'remote.git');
  const checkout = resolve(root, 'checkout');
  git(root, ['init', '--bare', '-q', bare]);
  git(root, ['init', '-q', '-b', 'main', checkout]);
  git(checkout, ['config', 'user.name', 'Operator']);
  git(checkout, ['config', 'user.email', 'operator@example.com']);
  writeFileSync(resolve(checkout, 'README.md'), '# scratch\n');
  git(checkout, ['add', 'README.md']);
  git(checkout, ['commit', '-qm', 'seed']);
  git(checkout, ['remote', 'add', 'origin', bare]);
  git(checkout, ['push', '-q', '-u', 'origin', 'main']);

  // Exactly where `cornersPoolRoot` puts corners for a paired checkout:
  // a hidden sibling of the checkout, named after it.
  const pool = resolve(root, '.beeline-corners', 'checkout');
  mkdirSync(pool, { recursive: true });
  const worktree = resolve(pool, subchannelId);
  git(checkout, ['worktree', 'add', '-q', '-b', 'feature/corner', worktree, 'main']);
  writeFileSync(resolve(worktree, 'WORK.txt'), 'unlanded work\n');
  git(worktree, ['add', 'WORK.txt']);
  git(worktree, ['commit', '-qm', 'the work a human approved']);
  const tip = git(worktree, ['rev-parse', 'HEAD']);
  git(worktree, ['push', '-q', 'origin', 'feature/corner']);

  const body = new Body(
    {
      agentBinary: '/bin/false',
      mcpBinary: '/bin/false',
      agentEnv: {},
      workspaceRoot: root,
      relayBaseUrl: 'http://relay.test',
      relayHost: 'relay.test',
      relayScheme: 'http',
      relayWsUrl: 'ws://relay.test',
      autoApprovePermissions: true,
    },
    undefined,
    undefined,
    undefined,
    { statePath: resolve(root, 'state.json') },
  );
  const info: SubchannelInfo = {
    subchannelId,
    worktreePath: worktree,
    featureBranch: 'feature/corner',
    role: body.agent,
    session: {
      channelId: subchannelId,
      sessionId: 'session',
      client: new AcpClient({ agentBinary: '/bin/false', agentEnv: {} }),
      mode: 'edit' as const,
      parentChannelId: 'room-channel',
      worktreePath: worktree,
      featureBranch: 'feature/corner',
    },
    lastPolledAt: 0,
    archived: false,
    boundRepo: {
      repo: 'scratch',
      localPath: checkout,
      remoteName: 'origin',
      targetBranch: 'refs/heads/main',
      repositoryKey: 'repo-key',
    },
  };
  body.registerSubchannel(info);
  return { root, bare, checkout, pool, worktree, body, info, tip };
}

/**
 * Capture every relay publish and never touch the network. `queryReply` answers
 * relay READS, so a test can put the relay in a definite state (a corner the
 * projection reports archived) rather than relying on a read that merely fails.
 */
function captureEvents(queryReply: readonly unknown[] = []): NostrEvent[] {
  const events: NostrEvent[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(typeof input === 'object' && 'url' in input ? input.url : input);
      if (url.endsWith('/query')) {
        return new Response(JSON.stringify(queryReply), { status: 200 });
      }
      events.push(JSON.parse(String(init?.body)) as NostrEvent);
      return new Response(JSON.stringify({ accepted: true }), { status: 200 });
    }),
  );
  return events;
}

/** The relay's own projection of a corner channel, as an archived corner. */
function archivedProjection(subchannelId: string): unknown {
  return {
    id: 'a'.repeat(64),
    pubkey: 'b'.repeat(64),
    created_at: Math.floor(Date.now() / 1000),
    kind: 39000,
    content: '',
    sig: 'c'.repeat(128),
    tags: [
      ['d', subchannelId],
      ['h', subchannelId],
      ['name', 'a-closed-corner'],
      ['t', 'stream'],
      ['archived', 'true'],
    ],
  };
}

function approve(body: Body, info: SubchannelInfo, tip: string): void {
  info.humanMergeApproval = { id: 'signed-human-approval', reviewer: 'human-admin', tip };
  vi.spyOn(body as never, 'findHumanMergeApproval' as never).mockResolvedValue(
    info.humanMergeApproval as never,
  );
}

function call<T>(body: Body, method: string, ...args: unknown[]): Promise<T> {
  const fn = Reflect.get(body, method) as (this: Body, ...rest: unknown[]) => Promise<T>;
  return fn.call(body, ...args);
}

/** A daemon with no live corners — the restarted-and-could-not-restore case. */
function sweeperBody(root: string): Body {
  return new Body(
    {
      agentBinary: '/bin/false',
      mcpBinary: '/bin/false',
      agentEnv: {},
      workspaceRoot: root,
      relayBaseUrl: 'http://relay.test',
      relayHost: 'relay.test',
      relayScheme: 'http',
      relayWsUrl: 'ws://relay.test',
      autoApprovePermissions: true,
    },
    undefined,
    undefined,
    undefined,
    { statePath: resolve(root, `sweeper-state-${Math.random().toString(36).slice(2)}.json`) },
  );
}

/** Every decision the sweep logged, so a test can name the rule that fired. */
async function sweep(body: Body, boundRepo: unknown): Promise<string[]> {
  const lines: string[] = [];
  const log = vi
    .spyOn(console, 'log')
    .mockImplementation((...args) => void lines.push(args.join(' ')));
  const warn = vi
    .spyOn(console, 'warn')
    .mockImplementation((...args) => void lines.push(args.join(' ')));
  try {
    await call(body, 'pruneStrayCornerWorktrees', boundRepo);
  } finally {
    log.mockRestore();
    warn.mockRestore();
  }
  return lines;
}

describe('the stray corner-worktree sweep never deletes work', () => {
  it('keeps a linked worktree whose git registration was lost with the checkout', async () => {
    // The live shape. The corner directory survives, but the checkout that
    // registered it was re-cloned, so its `.git` file points at admin records
    // that no longer exist: git can say nothing about the directory at all.
    // The old sweep read that silence as "orphan" and `rm -rf`'d a corner with
    // an unlanded, human-approved commit in it.
    const fixture = corner();
    rmSync(resolve(fixture.checkout, '.git', 'worktrees'), { recursive: true, force: true });
    captureEvents();

    const lines = await sweep(sweeperBody(fixture.root), fixture.info.boundRepo);

    expect(existsSync(resolve(fixture.worktree, 'WORK.txt'))).toBe(true);
    expect(lines.join('\n')).toContain('its contents could not be inspected');
  });

  it('keeps an unregistered directory that still holds unlanded commits', async () => {
    const fixture = corner();
    // A self-contained repository in the pool: git can read it perfectly well,
    // it just is not a registered worktree of the serving checkout. Nothing
    // about "the registry does not name it" says the commits are disposable.
    const stray = resolve(fixture.pool, 'corner-2');
    git(fixture.root, ['init', '-q', '-b', 'main', stray]);
    git(stray, ['config', 'user.name', 'Agent']);
    git(stray, ['config', 'user.email', 'agent@buzzy.local']);
    writeFileSync(resolve(stray, 'KEEP.txt'), 'work nobody has landed\n');
    git(stray, ['add', 'KEEP.txt']);
    git(stray, ['commit', '-qm', 'seed']);
    writeFileSync(resolve(stray, 'MORE.txt'), 'and more\n');
    git(stray, ['add', 'MORE.txt']);
    git(stray, ['commit', '-qm', 'unlanded']);
    git(stray, ['branch', '-f', 'landed-base', 'HEAD~1']);
    captureEvents();

    const lines = await sweep(sweeperBody(fixture.root), {
      ...(fixture.info.boundRepo as object),
      targetBranch: 'refs/heads/landed-base',
    });

    expect(existsSync(resolve(stray, 'MORE.txt'))).toBe(true);
    expect(lines.join('\n')).toContain('commit(s) not on the target branch');
  });

  it('keeps uncommitted changes even in a corner the relay reports archived', async () => {
    // The one branch that is genuinely allowed to delete: a registered
    // worktree whose corner is closed. Even there, work that exists nowhere
    // but this directory outranks tidiness.
    const fixture = corner();
    writeFileSync(resolve(fixture.worktree, 'WIP.txt'), 'not committed anywhere\n');
    captureEvents([archivedProjection(fixture.info.subchannelId)]);

    const lines = await sweep(sweeperBody(fixture.root), fixture.info.boundRepo);

    expect(existsSync(resolve(fixture.worktree, 'WIP.txt'))).toBe(true);
    expect(lines.join('\n')).toContain('it has uncommitted changes');
  });

  it('does reap a clean, registered worktree once its corner is archived', async () => {
    const fixture = corner();
    // Land the work so nothing is left that only this directory holds.
    git(fixture.checkout, ['merge', '--ff-only', '-q', 'feature/corner']);
    captureEvents([archivedProjection(fixture.info.subchannelId)]);

    const lines = await sweep(sweeperBody(fixture.root), fixture.info.boundRepo);

    expect(existsSync(fixture.worktree)).toBe(false);
    expect(lines.join('\n')).toContain('its corner is archived');
  });

  it('abandons the whole sweep when the worktree registry cannot be read', async () => {
    const fixture = corner();
    // `registeredWorktrees` returning `undefined` is the shape that used to be
    // an empty `Set` — i.e. "git tracks nothing here", which nominated every
    // directory in the pool for `rm -rf`. Now it stops the sweep dead.
    vi.spyOn(fixture.body as never, 'registeredWorktrees' as never).mockReturnValue(
      undefined as never,
    );
    captureEvents();
    await call(fixture.body, 'pruneStrayCornerWorktrees', fixture.info.boundRepo);

    expect(existsSync(fixture.worktree)).toBe(true);
  });

  it('still reaps a directory that is not a git worktree at all', async () => {
    const fixture = corner();
    const litter = resolve(fixture.pool, 'left-over-directory');
    mkdirSync(litter, { recursive: true });
    writeFileSync(resolve(litter, 'junk.bin'), 'x');

    captureEvents();
    await call(fixture.body, 'pruneStrayCornerWorktrees', fixture.info.boundRepo);

    expect(existsSync(litter)).toBe(false);
    expect(existsSync(fixture.worktree)).toBe(true);
  });

  it('logs a reason for every directory it decides about', async () => {
    const fixture = corner();
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args) => void lines.push(args.join(' ')));
    captureEvents();
    await call(fixture.body, 'pruneStrayCornerWorktrees', fixture.info.boundRepo);

    const decision = lines.find((line) => line.includes(fixture.worktree));
    expect(decision).toBeDefined();
    expect(decision).toMatch(/corner worktree sweep (keeping|reaping|repairing)/);
  });
});

describe('the sweep decision itself', () => {
  const clean = { isWorktree: true, dirty: false, unmergedCommits: 0, unknown: false };

  it('never reaps anything it could not inspect', () => {
    expect(
      cornerWorktreeSweepDecision({
        registered: false,
        live: false,
        tracked: false,
        archived: true,
        probe: { ...clean, unknown: true },
      }).action,
    ).toBe('keep');
  });

  it('keeps unlanded commits even when the corner is closed', () => {
    expect(
      cornerWorktreeSweepDecision({
        registered: true,
        live: false,
        tracked: false,
        archived: true,
        probe: { ...clean, unmergedCommits: 2 },
      }),
    ).toEqual({ action: 'keep', reason: 'it holds 2 commit(s) not on the target branch' });
  });

  it('only asks the relay once nothing on disk objects', () => {
    expect(
      cornerWorktreeSweepDecision({
        registered: true,
        live: false,
        tracked: false,
        probe: clean,
      }).action,
    ).toBe('ask');
    // ...and a dirty one never gets that far, so no relay answer can reap it.
    expect(
      cornerWorktreeSweepDecision({
        registered: true,
        live: false,
        tracked: false,
        probe: { ...clean, dirty: true },
      }).action,
    ).toBe('keep');
  });

  it('re-links a real worktree git has stopped registering instead of deleting it', () => {
    expect(
      cornerWorktreeSweepDecision({
        registered: false,
        live: false,
        tracked: false,
        archived: false,
        probe: clean,
      }),
    ).toEqual({ action: 'repair', reason: 'git no longer registers this worktree' });
  });

  it('reaps an archived corner that has nothing left on disk to lose', () => {
    expect(
      cornerWorktreeSweepDecision({
        registered: true,
        live: false,
        tracked: false,
        archived: true,
        probe: clean,
      }).action,
    ).toBe('reap');
  });

  it('keeps an archived corner that still has uncommitted changes', () => {
    expect(
      cornerWorktreeSweepDecision({
        registered: true,
        live: false,
        tracked: false,
        archived: true,
        probe: { ...clean, dirty: true },
      }).action,
    ).toBe('keep');
  });
});

describe('probing a corner directory', () => {
  it('reports unlanded commits against the real target ref', async () => {
    const fixture = corner();
    const refs = await resolveTargetRefs(fixture.worktree, ['refs/heads/main']);
    expect(refs).toEqual(['refs/heads/main']);
    const probe = await probeCornerWorktree(fixture.worktree, refs);
    expect(probe).toMatchObject({ isWorktree: true, dirty: false, unknown: false });
    expect(probe.unmergedCommits).toBe(1);
  });

  it('is unknown, never clean, when the target ref cannot be resolved', async () => {
    const fixture = corner();
    expect((await probeCornerWorktree(fixture.worktree, [])).unknown).toBe(true);
  });
});

describe('an approved change lands even while a corner is mid-turn', () => {
  it('runs the land poll before the corner member poll, not behind it', async () => {
    const fixture = corner();
    const order: string[] = [];
    // The live shape: a corner forwarding a human message awaits the whole
    // agent turn. Anything sequenced after it in the maintenance chain waits
    // that long too, which is what kept approvals from landing.
    let releaseTurn = (): void => {};
    const turn = new Promise<void>((res) => {
      releaseTurn = res;
    });
    vi.spyOn(fixture.body as never, 'pollMembers' as never).mockImplementation((async () => {
      order.push('members:start');
      await turn;
      order.push('members:end');
      return 0;
    }) as never);
    vi.spyOn(fixture.body as never, 'pollDirectRemoteApprovals' as never).mockImplementation(
      (async () => {
        order.push('land');
        return 0;
      }) as never,
    );
    vi.spyOn(fixture.body as never, 'pollMergeCompletions' as never).mockResolvedValue(0 as never);
    vi.spyOn(fixture.body as never, 'pollAbandonedCornerCloses' as never).mockResolvedValue(
      undefined as never,
    );
    vi.spyOn(fixture.body as never, 'pollUntrackedCornerCloses' as never).mockResolvedValue(
      undefined as never,
    );
    captureEvents();

    const maintenance = call(fixture.body, 'pollRoomMaintenance', 'room-channel', undefined, {
      ...fixture.info.boundRepo,
    });
    // Give the chain every chance to reach the land poll while the turn is
    // still running. If landing sits behind the member poll it cannot.
    await new Promise((res) => setTimeout(res, 30));
    expect(order).toContain('land');
    expect(order).not.toContain('members:end');

    releaseTurn();
    await maintenance;
  });
});

describe('a land that cannot be attempted is never silent', () => {
  it('reports a remote it could not read instead of skipping forever', async () => {
    const fixture = corner();
    // Point the remote at nothing: `ls-remote` fails rather than answering,
    // which the old code read as "the feature ref has not caught up" and
    // returned `skip` for, on every tick, with nothing published anywhere.
    git(fixture.worktree, ['remote', 'set-url', 'origin', resolve(fixture.root, 'gone.git')]);
    approve(fixture.body, fixture.info, fixture.tip);
    fixture.info.mergeTarget = {
      repo: 'remote/repo-key',
      branch: 'refs/heads/main',
      tip: fixture.tip,
    };
    const events = captureEvents();

    await call(fixture.body, 'pollDirectRemoteApprovals');

    const failures = events.filter((event) =>
      event.tags.some((tag) => tag[0] === 'status' && tag[1] === 'failed'),
    );
    expect(failures.length).toBeGreaterThan(0);
    expect(failures[0]!.content).toContain("Couldn't land the approved change");
  });

  it('states an unchanged refusal once, not once per maintenance tick', async () => {
    const fixture = corner();
    git(fixture.worktree, ['remote', 'set-url', 'origin', resolve(fixture.root, 'gone.git')]);
    approve(fixture.body, fixture.info, fixture.tip);
    fixture.info.mergeTarget = {
      repo: 'remote/repo-key',
      branch: 'refs/heads/main',
      tip: fixture.tip,
    };
    const events = captureEvents();

    for (let tick = 0; tick < 5; tick++) await call(fixture.body, 'pollDirectRemoteApprovals');

    const failures = events.filter(
      (event) =>
        event.tags.some((tag) => tag[0] === 'status' && tag[1] === 'failed') &&
        event.content.startsWith("Couldn't land the approved change"),
    );
    expect(failures).toHaveLength(1);
  });
});

describe('a corner whose worktree vanished is rebuilt, not written off', () => {
  it('recreates the checkout from the feature branch that still holds the work', async () => {
    const fixture = corner();
    // Exactly what the old sweep did to the captain's corners.
    git(fixture.checkout, ['worktree', 'remove', '--force', '--force', fixture.worktree]);
    expect(existsSync(fixture.worktree)).toBe(false);

    const rebuilt = Reflect.get(fixture.body, 'rematerializeCornerWorktree') as (
      this: Body,
      repo: unknown,
      path: string,
      branch: string,
    ) => Promise<boolean>;
    const ok = await rebuilt.call(
      fixture.body,
      fixture.info.boundRepo,
      fixture.worktree,
      'feature/corner',
    );

    expect(ok).toBe(true);
    expect(existsSync(resolve(fixture.worktree, 'WORK.txt'))).toBe(true);
    expect(git(fixture.worktree, ['rev-parse', 'HEAD'])).toBe(fixture.tip);
  });

  it('recovers the branch from the remote when the local ref is gone too', async () => {
    const fixture = corner();
    git(fixture.checkout, ['worktree', 'remove', '--force', '--force', fixture.worktree]);
    git(fixture.checkout, ['branch', '-D', 'feature/corner']);

    const rebuilt = Reflect.get(fixture.body, 'rematerializeCornerWorktree') as (
      this: Body,
      repo: unknown,
      path: string,
      branch: string,
    ) => Promise<boolean>;
    const ok = await rebuilt.call(
      fixture.body,
      fixture.info.boundRepo,
      fixture.worktree,
      'feature/corner',
    );

    expect(ok).toBe(true);
    expect(git(fixture.worktree, ['rev-parse', 'HEAD'])).toBe(fixture.tip);
  });

  it('refuses rather than resurrect a corner whose branch is genuinely gone', async () => {
    const fixture = corner();
    git(fixture.checkout, ['worktree', 'remove', '--force', '--force', fixture.worktree]);
    git(fixture.checkout, ['branch', '-D', 'feature/corner']);
    git(fixture.checkout, ['push', '-q', 'origin', '--delete', 'feature/corner']);

    const rebuilt = Reflect.get(fixture.body, 'rematerializeCornerWorktree') as (
      this: Body,
      repo: unknown,
      path: string,
      branch: string,
    ) => Promise<boolean>;
    expect(
      await rebuilt.call(fixture.body, fixture.info.boundRepo, fixture.worktree, 'feature/corner'),
    ).toBe(false);
    expect(existsSync(fixture.worktree)).toBe(false);
  });
});

describe('a second corner is never opened for work already running', () => {
  const live = {
    subchannelId: 'corner-1',
    name: 'feel-free-to-open-all-three-at-once',
    taskDescription: 'feel free to open all three at once',
    openedAt: 1_000_000,
  };

  it('folds a bare "open corner" into the corner opened moments ago', () => {
    // The live sequence: "@Beebee Open corner - feel free to open all three at
    // once" then, fifty seconds later, a bare "@beebee open corner".
    // Distilled the way the daemon distils it: a bare imperative peels down
    // to nothing, which is precisely why the corner it opened had no objective.
    expect(taskDescriptionFromCornerRequest('@beebee open corner')).toBe('');
    const found = duplicateCornerOpen({
      taskDescription: taskDescriptionFromCornerRequest('@beebee open corner'),
      now: live.openedAt + 50_000,
      corners: [live],
    });
    expect(found).toBe(live);
    expect(duplicateCornerOpenRefusal(found!)).toContain(live.name);
  });

  it('lets a bare "open corner" long after the last one open a fresh corner', () => {
    expect(
      duplicateCornerOpen({
        taskDescription: taskDescriptionFromCornerRequest('open a corner'),
        now: live.openedAt + CORNER_OPEN_DUPLICATE_WINDOW_MS + 1,
        corners: [live],
      }),
    ).toBeUndefined();
  });

  it('refuses a repeat of the same objective however it is phrased', () => {
    expect(
      duplicateCornerOpen({
        taskDescription: taskDescriptionFromCornerRequest(
          '@beebee open a corner - Feel free to open all three at once.',
        ),
        now: live.openedAt + 5 * 60 * 60_000,
        corners: [live],
      }),
    ).toBe(live);
  });

  it('opens a genuinely different task alongside a live corner', () => {
    expect(
      duplicateCornerOpen({
        taskDescription: taskDescriptionFromCornerRequest(
          '@beebee open a corner to fix the offline banner',
        ),
        now: live.openedAt + 10_000,
        corners: [live],
      }),
    ).toBeUndefined();
  });

  it('does not consider an archived corner a duplicate (the daemon filters it out first)', () => {
    expect(
      duplicateCornerOpen({ taskDescription: '', now: live.openedAt, corners: [] }),
    ).toBeUndefined();
  });
});

describe('an unrestorable corner says so once, not once per restart', () => {
  it('keeps the wording in one place so the daemon can recognise its own card', () => {
    expect(CORNER_WORKTREE_UNRESTORABLE).toContain('could not restore this corner worktree');
  });
});
