/**
 * What happens to a corner AFTER a human approves the land.
 *
 * Two behaviours meet here, and both are proved against real git repositories
 * and real signed relay events rather than against mocks of the daemon's own
 * code:
 *
 *   1. The land push carries a release corner's annotated tag (`--follow-tags`
 *      on the existing push) — asserted by reading the bare remote's refs after
 *      a real `pollDirectRemoteApprovals` run.
 *   2. The landed commit's CI is watched and reported exactly once to the
 *      parent Room — and never at all for a repository that has no GitHub
 *      remote to ask, which is what keeps a local-only repo silent instead of
 *      erroring.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AcpClient } from './acp.js';
import { Body, CI_RESULT_TAG, LAND_SUMMARY_TAG, LANDED_TAG, type SubchannelInfo } from './body.js';
import type { NostrEvent } from '@beeline/nostr';

const cleanup: string[] = [];
afterEach(async () => {
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
  checkout: string;
  remote?: string;
  worktree: string;
  info: SubchannelInfo;
  body: Body;
  tip: string;
}

/**
 * A corner with one committed change, over a repository that either has a real
 * bare remote (`remoteUrl` unset → a file remote we can actually push to) or
 * no remote at all (`localOnly` → the local-only shape), or a remote whose URL
 * is whatever the test needs `git remote get-url` to report.
 */
function corner(options: { localOnly?: boolean; remoteUrl?: string } = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'beeline-land-followup-'));
  cleanup.push(root);
  const bare = resolve(root, 'remote.git');
  const checkout = resolve(root, 'checkout');
  const worktree = resolve(root, 'corner');
  git(root, ['init', '--bare', '-q', bare]);
  git(root, ['init', '-q', '-b', 'main', checkout]);
  git(checkout, ['config', 'user.name', 'Operator']);
  git(checkout, ['config', 'user.email', 'operator@example.com']);
  writeFileSync(resolve(checkout, 'README.md'), '# scratch\n');
  git(checkout, ['add', 'README.md']);
  git(checkout, ['commit', '-qm', 'seed']);
  if (!options.localOnly) {
    git(checkout, ['remote', 'add', 'origin', options.remoteUrl ?? bare]);
    if (!options.remoteUrl) git(checkout, ['push', '-q', '-u', 'origin', 'main']);
  }
  git(checkout, ['worktree', 'add', '-q', '-b', 'feature/corner', worktree, 'main']);
  writeFileSync(resolve(worktree, 'LANDED.txt'), 'landed by the agent\n');
  git(worktree, ['add', 'LANDED.txt']);
  git(worktree, ['commit', '-qm', 'Add landed proof']);
  const tip = git(worktree, ['rev-parse', 'HEAD']);

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
    subchannelId: 'corner-channel',
    worktreePath: worktree,
    featureBranch: 'feature/corner',
    role: body.agent,
    session: {
      channelId: 'corner-channel',
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
      targetBranch: 'refs/heads/main',
      repositoryKey: 'land-followup',
      ...(options.localOnly ? {} : { remoteName: 'origin' }),
    },
  };
  body.registerSubchannel(info);
  return {
    root,
    checkout,
    worktree,
    info,
    body,
    tip,
    ...(options.localOnly ? {} : { remote: bare }),
  };
}

/** Capture every relay publish, and never let a test reach the network. */
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

function tagged(events: NostrEvent[], value: string): NostrEvent[] {
  return events.filter((event) => event.tags.some((tag) => tag[0] === 't' && tag[1] === value));
}

/** Approve this exact tip as a device-held human admin would have. */
function approve(body: Body, info: SubchannelInfo, tip: string): void {
  info.humanMergeApproval = { id: 'signed-human-approval', reviewer: 'human-admin', tip };
  vi.spyOn(body as never, 'findHumanMergeApproval' as never).mockResolvedValue(
    info.humanMergeApproval as never,
  );
}

async function publishMergeReady(body: Body, info: SubchannelInfo): Promise<boolean> {
  const publish = Reflect.get(body, 'publishMergeReady') as (
    this: Body,
    value: SubchannelInfo,
  ) => Promise<boolean>;
  return publish.call(body, info);
}

describe("a release corner's tag reaches the remote when the change lands", () => {
  it('pushes the annotated tag with the approved tip, and only then', async () => {
    const { remote, worktree, info, body, tip } = corner();
    const events = captureEvents();
    // What a release corner produces: the release commit, tagged annotated.
    git(worktree, ['tag', '-a', 'v1.2.0', '-m', 'v1.2.0']);

    await expect(publishMergeReady(body, info)).resolves.toBe(true);
    // Advertising work for review must not publish the tag — the tag lands
    // with the change a human approved, not with the change they are reading.
    expect(git(worktree, ['ls-remote', '--tags', remote!])).toBe('');

    approve(body, info, tip);
    await expect(
      (Reflect.get(body, 'pollDirectRemoteApprovals') as () => Promise<number>).call(body),
    ).resolves.toBe(1);

    expect(git(worktree, ['ls-remote', remote!, 'refs/heads/main'])).toContain(tip);
    const remoteTags = git(worktree, ['ls-remote', '--tags', remote!]);
    expect(remoteTags).toContain('refs/tags/v1.2.0');
    // The annotated tag's peeled target is the commit that landed.
    expect(remoteTags).toContain(`${tip}\trefs/tags/v1.2.0^{}`);
    expect(tagged(events, LANDED_TAG)).toHaveLength(1);
  });

  it('leaves a lightweight tag behind rather than landing an unauthored one', async () => {
    const { remote, worktree, info, body, tip } = corner();
    captureEvents();
    git(worktree, ['tag', 'nightly']);

    await expect(publishMergeReady(body, info)).resolves.toBe(true);
    approve(body, info, tip);
    await expect(
      (Reflect.get(body, 'pollDirectRemoteApprovals') as () => Promise<number>).call(body),
    ).resolves.toBe(1);

    expect(git(worktree, ['ls-remote', remote!, 'refs/heads/main'])).toContain(tip);
    expect(git(worktree, ['ls-remote', '--tags', remote!])).toBe('');
  });

  it('needs no push at all for a local-only repository — the tag is already there', async () => {
    const { checkout, worktree, info, body, tip } = corner({ localOnly: true });
    captureEvents();
    git(worktree, ['tag', '-a', 'v0.1.0', '-m', 'v0.1.0']);

    await expect(publishMergeReady(body, info)).resolves.toBe(true);
    approve(body, info, tip);
    await expect(
      (Reflect.get(body, 'pollDirectRemoteApprovals') as () => Promise<number>).call(body),
    ).resolves.toBe(1);

    expect(git(checkout, ['rev-parse', 'refs/heads/main'])).toBe(tip);
    // Same ref store: the corner's worktree is a linked worktree of this repo.
    expect(git(checkout, ['rev-parse', 'refs/tags/v0.1.0^{}'])).toBe(tip);
  });
});

describe('the CI report that follows a land', () => {
  /**
   * The land itself is driven for real (file remote / local checkout, no
   * network); the GitHub half is driven through `watchLandedCommitCi` on a
   * checkout whose origin really is a github.com URL. That method performs no
   * git network operation of its own — it reads the remote and the ambient
   * credential locally — so the whole path except the HTTP call is real, and
   * the HTTP call is the one thing a test must not make.
   */

  /** One canned GitHub API answer, and a count of how often it was asked. */
  function githubApi(checkRuns: unknown[]): { fetchImpl: typeof fetch; calls: () => number } {
    let calls = 0;
    return {
      calls: () => calls,
      fetchImpl: (async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes('/status')) {
          calls++;
          return new Response(JSON.stringify({ state: 'pending', statuses: [], total_count: 0 }), {
            status: 200,
          });
        }
        return new Response(
          JSON.stringify({ total_count: checkRuns.length, check_runs: checkRuns }),
          { status: 200 },
        );
      }) as typeof fetch,
    };
  }

  function armWatch(body: Body, options: Record<string, unknown>): void {
    Reflect.set(body, 'ciWatchOptions', {
      pollMs: 1,
      timeoutMs: 50,
      noneGraceMs: 0,
      token: 'test-token',
      ...options,
    });
  }

  /** Run the watch the way the land does, and wait for it to finish. */
  async function watchLanded(fixture: Fixture, replyTo = 'recap-event'): Promise<void> {
    const watch = Reflect.get(fixture.body, 'watchLandedCommitCi') as (
      this: Body,
      info: SubchannelInfo,
      tip: string,
      replyTo?: string,
    ) => void;
    watch.call(fixture.body, fixture.info, fixture.tip, replyTo);
    await Promise.allSettled([
      ...(Reflect.get(fixture.body, 'pendingCiWatches') as Set<Promise<void>>),
    ]);
    await fixture.body.dispose();
  }

  /** A real, human-approved land over a file remote, start to finish. */
  async function land(fixture: Fixture): Promise<NostrEvent[]> {
    const events = captureEvents();
    // Archival is a separate human-authorized effect with its own relay
    // authority reads; this suite is about what follows the land, not teardown.
    Reflect.set(fixture.body, 'archiveSubchannel', async () => undefined);
    await publishMergeReady(fixture.body, fixture.info);
    approve(fixture.body, fixture.info, fixture.tip);
    await (Reflect.get(fixture.body, 'pollDirectRemoteApprovals') as () => Promise<number>).call(
      fixture.body,
    );
    // No ACP backend in this fixture: the recap falls back to its deterministic
    // line, exactly as it does against a dead session in production.
    await expect(fixture.body.pollMergeCompletions()).resolves.toBe(1);
    return events;
  }

  it('reports a pass once, in the parent Room, threaded to the land recap', async () => {
    const fixture = corner({ remoteUrl: 'https://github.com/acme/widgets.git' });
    const api = githubApi([{ name: 'build', status: 'completed', conclusion: 'success' }]);
    const events = captureEvents();
    armWatch(fixture.body, { fetchImpl: api.fetchImpl });
    await watchLanded(fixture, 'recap-event');

    const reports = tagged(events, CI_RESULT_TAG);
    expect(reports).toHaveLength(1);
    expect(reports[0]!.tags).toContainEqual(['h', 'room-channel']);
    expect(reports[0]!.content).toBe(
      `CI ✓ — every check passed for the change that landed on main (${fixture.tip.slice(0, 12)}).`,
    );
    // Threaded to the recap, so it reads as the same story continuing.
    expect(reports[0]!.tags).toContainEqual(['e', 'recap-event', '', 'reply']);
    expect(reports[0]!.tags).toContainEqual(['tip', fixture.tip]);
    expect(reports[0]!.tags).toContainEqual(['ci', 'success']);
    expect(api.calls()).toBeGreaterThan(0);
  });

  it('names the failing check and links it', async () => {
    const fixture = corner({ remoteUrl: 'git@github.com:acme/widgets.git' });
    const api = githubApi([
      { name: 'lint', status: 'completed', conclusion: 'success' },
      {
        name: 'deploy',
        status: 'completed',
        conclusion: 'failure',
        html_url: 'https://github.com/acme/widgets/runs/42',
      },
    ]);
    const events = captureEvents();
    armWatch(fixture.body, { fetchImpl: api.fetchImpl });
    await watchLanded(fixture);

    const reports = tagged(events, CI_RESULT_TAG);
    expect(reports).toHaveLength(1);
    expect(reports[0]!.content).toContain('CI ✗ — deploy failed');
    expect(reports[0]!.content).toContain('https://github.com/acme/widgets/runs/42');
    expect(reports[0]!.tags).toContainEqual(['ci', 'failure']);
  });

  it('says nothing when the repository runs no CI on that commit', async () => {
    const fixture = corner({ remoteUrl: 'https://github.com/acme/widgets.git' });
    const api = githubApi([]);
    const events = captureEvents();
    armWatch(fixture.body, { fetchImpl: api.fetchImpl });
    await watchLanded(fixture);

    expect(tagged(events, CI_RESULT_TAG)).toHaveLength(0);
    // It did look — silence here is an answer, not a skipped step.
    expect(api.calls()).toBeGreaterThan(0);
  });

  it('says nothing while CI is still running when the budget runs out', async () => {
    const fixture = corner({ remoteUrl: 'https://github.com/acme/widgets.git' });
    const api = githubApi([{ name: 'e2e', status: 'in_progress', conclusion: null }]);
    const events = captureEvents();
    armWatch(fixture.body, { fetchImpl: api.fetchImpl });
    await watchLanded(fixture);

    expect(tagged(events, CI_RESULT_TAG)).toHaveLength(0);
  });

  it('watches a landed commit exactly once, however many times the poll runs', async () => {
    const fixture = corner({ remoteUrl: 'https://github.com/acme/widgets.git' });
    const api = githubApi([{ name: 'build', status: 'completed', conclusion: 'success' }]);
    const events = captureEvents();
    armWatch(fixture.body, { fetchImpl: api.fetchImpl });

    const watch = Reflect.get(fixture.body, 'watchLandedCommitCi') as (
      this: Body,
      info: SubchannelInfo,
      tip: string,
      replyTo?: string,
    ) => void;
    watch.call(fixture.body, fixture.info, fixture.tip, 'recap-event');
    watch.call(fixture.body, fixture.info, fixture.tip, 'recap-event');
    watch.call(fixture.body, fixture.info, fixture.tip, 'recap-event');
    await Promise.allSettled([
      ...(Reflect.get(fixture.body, 'pendingCiWatches') as Set<Promise<void>>),
    ]);
    await fixture.body.dispose();

    expect(tagged(events, CI_RESULT_TAG)).toHaveLength(1);
  });

  it('never asks about a local-only repository — no message, and no error', async () => {
    const fixture = corner({ localOnly: true });
    const fetchImpl = vi.fn(async () => {
      throw new Error('a local-only repository must never reach the GitHub API');
    }) as unknown as typeof fetch;
    armWatch(fixture.body, { fetchImpl });
    const events = await land(fixture);
    await fixture.body.dispose();

    expect(tagged(events, LAND_SUMMARY_TAG)).toHaveLength(1);
    expect(tagged(events, CI_RESULT_TAG)).toHaveLength(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('never asks about a remote that is not GitHub', async () => {
    const fixture = corner();
    const fetchImpl = vi.fn(async () => {
      throw new Error('a non-GitHub remote must never reach the GitHub API');
    }) as unknown as typeof fetch;
    armWatch(fixture.body, { fetchImpl });
    const events = await land(fixture);
    await fixture.body.dispose();

    expect(tagged(events, LAND_SUMMARY_TAG)).toHaveLength(1);
    expect(tagged(events, CI_RESULT_TAG)).toHaveLength(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('starts the watch from the land itself, on the landed tip and the recap it follows', async () => {
    const fixture = corner();
    const started: unknown[][] = [];
    vi.spyOn(fixture.body as never, 'watchLandedCommitCi' as never).mockImplementation(((
      ...args: unknown[]
    ) => {
      started.push(args);
    }) as never);
    const events = await land(fixture);

    const summary = tagged(events, LAND_SUMMARY_TAG);
    expect(summary).toHaveLength(1);
    expect(started).toHaveLength(1);
    expect(started[0]![1]).toBe(fixture.tip);
    // Threading the report to the recap is why the recap's id is passed here.
    expect(started[0]![2]).toBe(summary[0]!.id);
  });

  it('never exposes the pairing-history checkout in a land recap', async () => {
    const fixture = corner();
    const operator = resolve(fixture.root, 'operator-tree');
    git(fixture.root, ['init', '-q', '-b', 'main', operator]);
    vi.spyOn(fixture.body as never, 'watchLandedCommitCi' as never).mockImplementation(
      (() => undefined) as never,
    );

    const events = await land(fixture);
    const summary = tagged(events, LAND_SUMMARY_TAG);
    expect(summary).toHaveLength(1);
    expect(summary[0]!.content).toContain('Landed on main at');
    expect(summary[0]!.content).not.toContain(operator);
  });

  it('never claims a checkout is behind when it already has the commit', async () => {
    const fixture = corner();
    // The corner's own worktree certainly holds the landed tip.
    vi.spyOn(fixture.body as never, 'watchLandedCommitCi' as never).mockImplementation(
      (() => undefined) as never,
    );

    const events = await land(fixture);
    const summary = tagged(events, LAND_SUMMARY_TAG);
    expect(summary[0]!.content).not.toContain('has not fetched this yet');
  });

  it('carries the commit page for a GitHub remote, in the prose and on a tag', async () => {
    // The land itself needs a pushable remote and a GitHub URL is not one, so
    // this drives the recap the land calls rather than the push before it —
    // the same function, the same corner state, one step later.
    const fixture = corner({ remoteUrl: 'https://github.com/lunchboxfortwo/buzzy.git' });
    const events = captureEvents();
    const recap = Reflect.get(fixture.body, 'publishCornerLandSummary') as (
      this: Body,
      info: SubchannelInfo,
      tip: string,
      parentId: string,
    ) => Promise<string | undefined>;
    await recap.call(fixture.body, fixture.info, fixture.tip, 'room-channel');

    const summary = tagged(events, LAND_SUMMARY_TAG);
    expect(summary).toHaveLength(1);
    expect(summary[0]!.content).toContain(
      `https://github.com/lunchboxfortwo/buzzy/commit/${fixture.tip}`,
    );
    // On a tag too, so a client can render it as a link without parsing prose.
    expect(summary[0]!.tags).toContainEqual([
      'url',
      `https://github.com/lunchboxfortwo/buzzy/commit/${fixture.tip}`,
    ]);
  });

  it('publishes no commit URL for a repository GitHub does not host', async () => {
    const fixture = corner();
    vi.spyOn(fixture.body as never, 'watchLandedCommitCi' as never).mockImplementation(
      (() => undefined) as never,
    );

    const events = await land(fixture);
    const summary = tagged(events, LAND_SUMMARY_TAG);
    expect(summary[0]!.content).not.toContain('https://');
    expect(summary[0]!.tags.some((tag) => tag[0] === 'url')).toBe(false);
  });
});
