/**
 * The land→archive race that made a live corner vanish and go message-deaf
 * (owner-reported 2026-08-23, from production daemon logs of agent 54f4d261…).
 *
 * The old sequence: a corner lands → the completion poll archives the channel
 * immediately → the agent session is STILL LIVE and keeps working → the relay
 * refuses every further kind:9 event on the archived channel
 * (`HTTP 400 {"error":"invalid: channel is archived"}`), so post-landing agent
 * output is silently discarded — and since archived corners are hidden (#375),
 * a working corner vanishes mid-conversation.
 *
 * The contract pinned here:
 *   1. Landing freezes new turns and immediately suspends an idle warm session,
 *      then archives and reaps its worktree.
 *   2. A genuinely mid-turn session is never interrupted; its turn-finally
 *      path drains and closes the corner as soon as the run settles.
 *   3. Landing with no live session archives immediately.
 *   4. A session-state publish refused because the channel is archived is an
 *      expected terminal no-op: one plain log line, never a thrown error.
 *
 * The land itself is driven for real over a file remote; the relay is a
 * recorded fetch stub, exactly as in `land-followup.test.ts`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AcpClient } from './acp.js';
import { Body, type SubchannelInfo } from './body.js';
import { mediaUploadResponse, relayQueryResponse } from './relay-test-helper.js';
import { newIdentity } from '@beeline/gate';
import { signEvent, type Identity, type NostrEvent } from '@beeline/nostr';

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
  remote: string;
  worktree: string;
  info: SubchannelInfo;
  body: Body;
  tip: string;
}

/** A corner with one committed change, over a repository with a real bare file remote. */
function corner(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'beeline-land-archive-'));
  cleanup.push(root);
  const bare = resolve(root, 'remote.git');
  const checkout = resolve(root, 'checkout');
  const worktree = resolve(root, 'corner');
  git(root, ['init', '--bare', '-q', bare]);
  git(root, ['init', '-q', '-b', 'main', checkout]);
  git(checkout, ['config', 'user.name', 'Operator']);
  git(checkout, ['config', 'user.email', 'operator@example.com']);
  git(checkout, ['remote', 'add', 'origin', bare]);
  writeFileSync(resolve(checkout, 'README.md'), '# scratch\n');
  git(checkout, ['add', 'README.md']);
  git(checkout, ['commit', '-qm', 'seed']);
  git(checkout, ['push', '-q', '-u', 'origin', 'main']);
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
      logicalSessionId: `${body.agent.publicKey}:corner-channel`,
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
      repositoryKey: 'land-archive',
      remoteName: 'origin',
    },
  };
  body.registerSubchannel(info);
  // Deferred-archive narration reads conversation history through the
  // authenticated server-indexed Room read (`Body.agentHistory`), not the
  // relay `/query`/publish surface this fixture's `stubRelayHttp` models;
  // these tests assert on the archive/publish sequencing, not on history
  // content, so an empty history is sufficient.
  vi.spyOn(body as never, 'agentHistory' as never).mockResolvedValue([] as never);
  return { root, checkout, remote: bare, worktree, info, body, tip };
}

/**
 * Serve the corner's kind:9007 create event to `/query` (the archive
 * authority read), record every publish, and accept them — unless
 * `refusePublishesWith` turns publishes into the relay's archived-channel
 * verdict instead.
 */
function stubRelayHttp(
  creates: NostrEvent[],
  refusePublishesWith?: { status: number; body: string },
): NostrEvent[] {
  const published: NostrEvent[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith('/query')) {
        return relayQueryResponse([...creates, ...published], input, init)!;
      }
      const upload = mediaUploadResponse(input, init);
      if (upload) return upload;
      published.push(JSON.parse(String(init?.body)) as NostrEvent);
      if (refusePublishesWith) {
        return new Response(refusePublishesWith.body, { status: refusePublishesWith.status });
      }
      return new Response(JSON.stringify({ accepted: true }), { status: 200 });
    }),
  );
  return published;
}

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

async function land(fixture: Fixture): Promise<void> {
  await publishMergeReady(fixture.body, fixture.info);
  approve(fixture.body, fixture.info, fixture.tip);
  await expect(
    (Reflect.get(fixture.body, 'pollDirectRemoteApprovals') as () => Promise<number>).call(
      fixture.body,
    ),
  ).resolves.toBe(1);
}

function archiveEvents(published: NostrEvent[]): NostrEvent[] {
  return published.filter(
    (event) =>
      event.kind === 9002 && event.tags.some((tag) => tag[0] === 'archived' && tag[1] === 'true'),
  );
}

/** Fire the scheduler's retire signal through the real lifecycle wiring. */
async function retireSession(fixture: Fixture): Promise<void> {
  const onStateChange = Reflect.get(fixture.body, 'onCornerSessionStateChange') as (
    this: Body,
    session: SubchannelInfo['session'],
    channelId: string,
    state: 'live' | 'suspended' | 'waiting-for-slot',
  ) => Promise<void>;
  await onStateChange.call(
    fixture.body,
    fixture.info.session,
    fixture.info.subchannelId,
    'suspended',
  );
}

describe('a landed corner whose agent session is still live', () => {
  it('promptly drains an idle warm session, archives the corner, and reaps its worktree', async () => {
    const fixture = corner();
    const published = stubRelayHttp([
      createCornerCreateEvent(fixture.body.agent, 'corner-channel', 'room-channel'),
    ]);
    fixture.info.session.processState = 'live';
    const scheduler = Reflect.get(fixture.body, 'scheduler') as {
      suspend(channelId: string): Promise<void>;
    };
    const suspend = vi.spyOn(scheduler, 'suspend').mockImplementation(async (channelId) => {
      expect(channelId).toBe('corner-channel');
      fixture.info.session.processState = 'suspended';
    });

    await land(fixture);
    const closeStartedAt = Date.now();
    await expect(fixture.body.pollMergeCompletions()).resolves.toBe(1);

    expect(tagged(published, 'merge-summary')).toHaveLength(0);
    expect(tagged(published, 'land-summary')).toHaveLength(1);
    expect(fixture.info.landedTip).toBe(fixture.tip);
    expect(suspend).toHaveBeenCalledOnce();
    expect(fixture.info.archiveWhenSessionRetires).toBe(true);
    expect(fixture.body.getSubchannels().has('corner-channel')).toBe(false);
    expect(archiveEvents(published)).toHaveLength(1);
    expect(Date.now() - closeStartedAt).toBeLessThan(2_000);
    expect(() => git(fixture.checkout, ['worktree', 'list', '--porcelain'])).not.toThrow();
    expect(git(fixture.checkout, ['worktree', 'list', '--porcelain'])).not.toContain(
      fixture.worktree,
    );
  });

  it('never interrupts a mid-turn session, then drains and closes as soon as the turn settles', async () => {
    const fixture = corner();
    const published = stubRelayHttp([
      createCornerCreateEvent(fixture.body.agent, 'corner-channel', 'room-channel'),
    ]);
    fixture.info.session.processState = 'live';
    let activeRunId: string | null = 'run-in-progress';
    fixture.info.session.client.activeRunId = () => activeRunId;
    const scheduler = Reflect.get(fixture.body, 'scheduler') as {
      suspend(channelId: string): Promise<void>;
    };
    const suspend = vi.spyOn(scheduler, 'suspend').mockImplementation(async () => {
      fixture.info.session.processState = 'suspended';
    });

    await land(fixture);
    await expect(fixture.body.pollMergeCompletions()).resolves.toBe(1);

    expect(suspend).not.toHaveBeenCalled();
    expect(fixture.body.getSubchannels().has('corner-channel')).toBe(true);
    expect(archiveEvents(published)).toHaveLength(0);

    activeRunId = null;
    await (
      Reflect.get(fixture.body, 'runDeferredLandArchive') as (
        this: Body,
        channelId: string,
      ) => Promise<void>
    ).call(fixture.body, 'corner-channel');

    expect(suspend).toHaveBeenCalledOnce();
    expect(fixture.body.getSubchannels().has('corner-channel')).toBe(false);
    expect(archiveEvents(published)).toHaveLength(1);
  });

  it('does not restate the merge summary while an active turn drains', async () => {
    const fixture = corner();
    const published = stubRelayHttp([
      createCornerCreateEvent(fixture.body.agent, 'corner-channel', 'room-channel'),
    ]);
    fixture.info.session.processState = 'live';
    fixture.info.session.client.activeRunId = () => 'run-in-progress';
    await land(fixture);

    await expect(fixture.body.pollMergeCompletions()).resolves.toBe(1);
    await expect(fixture.body.pollMergeCompletions()).resolves.toBe(1);

    expect(tagged(published, 'merge-summary')).toHaveLength(0);
    expect(tagged(published, 'land-summary')).toHaveLength(1);
    expect(archiveEvents(published)).toHaveLength(0);
  });

  it('archives immediately when no live session exists at landing (common case)', async () => {
    const fixture = corner();
    const published = stubRelayHttp([
      createCornerCreateEvent(fixture.body.agent, 'corner-channel', 'room-channel'),
    ]);
    // processState left undefined: the session was never activated.

    await land(fixture);
    await expect(fixture.body.pollMergeCompletions()).resolves.toBe(1);

    expect(fixture.body.getSubchannels().has('corner-channel')).toBe(false);
    expect(archiveEvents(published)).toHaveLength(1);
    // The close intent is recorded before the no-session fast path archives.
    expect(fixture.info.archiveWhenSessionRetires).toBe(true);
  });

  it('converges through the maintenance backstop when the retire notification was skipped', async () => {
    const fixture = corner();
    const published = stubRelayHttp([
      createCornerCreateEvent(fixture.body.agent, 'corner-channel', 'room-channel'),
    ]);
    fixture.info.session.processState = 'live';
    await land(fixture);
    await fixture.body.pollMergeCompletions();
    expect(archiveEvents(published)).toHaveLength(0);

    // The session retired without the lifecycle notification reaching the
    // hook (force-suspension paths); the per-corner maintenance visit still
    // archives it.
    fixture.info.session.processState = 'suspended';
    await expect(fixture.body.pollMembers('corner-channel')).resolves.toBe(0);

    expect(fixture.body.getSubchannels().has('corner-channel')).toBe(false);
    expect(archiveEvents(published)).toHaveLength(1);
  });
});

describe('retired session state', () => {
  it('is silent after archive', async () => {
    const fixture = corner();
    stubRelayHttp([createCornerCreateEvent(fixture.body.agent, 'corner-channel', 'room-channel')], {
      status: 400,
      body: '{"error":"invalid: channel is archived"}',
    });

    // Archive first (publishes are refused here too, so drive the state the
    // real close leaves behind), then fire the suspended-state publish that
    // used to land in the log as an unhandled error. A LIVE session retiring
    // mid-run — not the silent creation-time bookkeeping.
    fixture.info.session.processState = 'live';
    fixture.info.archived = true;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(retireSession(fixture)).resolves.toBeUndefined();

      expect(errorSpy).not.toHaveBeenCalledWith(
        'failed to publish corner session state suspended:',
        expect.anything(),
      );
      expect(logSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('session-state publish'),
      );
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it('does not attempt a transcript write even when the relay is unavailable', async () => {
    const fixture = corner();
    stubRelayHttp([createCornerCreateEvent(fixture.body.agent, 'corner-channel', 'room-channel')], {
      status: 500,
      body: 'relay unavailable',
    });

    fixture.info.session.processState = 'live';
    fixture.info.archived = true;
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await retireSession(fixture);
      expect(errorSpy).not.toHaveBeenCalledWith(
        '[body] failed to publish corner session state suspended:',
        expect.anything(),
      );
    } finally {
      errorSpy.mockRestore();
    }
  });
});

function tagged(events: NostrEvent[], value: string): NostrEvent[] {
  return events.filter((event) => event.tags.some((tag) => tag[0] === 't' && tag[1] === value));
}

/** The immutable kind:9007 create event that proves a channel is a corner. */
const CREATE_KIND = 9007;

function createCornerCreateEvent(
  agent: Identity,
  subchannelId: string,
  parentId: string,
): NostrEvent {
  return signEvent(
    {
      pubkey: agent.publicKey,
      created_at: Math.floor(Date.now() / 1000),
      kind: CREATE_KIND,
      tags: [
        ['h', subchannelId],
        ['parent', parentId],
      ],
      content: '',
    },
    agent.secretKey,
  );
}
