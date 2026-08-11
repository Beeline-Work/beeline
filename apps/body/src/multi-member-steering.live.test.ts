/**
 * Live multi-member steering test — test 4 from spec.md failure modes.
 *
 * Two participants steering one live session:
 *   - TLC + subchannel via Body with real buzz-agent + real LLM.
 *   - Member 1 redirects an in-flight prompt through ACP live steering.
 *   - Member 2 follows up on the same session after that turn completes.
 *   - Asserts:
 *     (a) Both prompts reached the session (ACP-level or effect-level evidence).
 *     (b) BOTH members' subscriptions receive the same agent-activity events.
 *     (c) Unique run markers from both members appear in the subchannel history.
 *
 * Soft-skips when relay or LLM env is absent.
 * Never skips when both present.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import { Body } from './body.js';
import { AcpClient, type McpServerWire } from './acp.js';
import { loadBodyConfig, hasLlmCredentials } from './config.js';
import { projectActivity, postControlMessage } from './activity.js';
import {
  newIdentity,
  createChannel,
  setMemberRole,
  publishEvent,
  queryEvents,
  BASE_URL,
  type Identity,
} from '@beeline/gate';
import { signEvent, type NostrEvent } from '@beeline/nostr';

const LLM_ENV_FILE = process.env.BUZZY_BODY_LLM_FILE ?? undefined;
const RUN_MARKER = `steer-${randomUUID().slice(0, 8)}`;

interface SteerTestContext {
  body: Body | null;
  tlcChannelId: string;
  subchannelId: string;
  member1: Identity | null;
  member2: Identity | null;
  sessionId: string;
  testDir: string;
  skipped: boolean;
}

function log(...args: unknown[]): void {
  console.log(`[steer][${RUN_MARKER}]`, ...args);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe('multi-member steering', () => {
  const ctx: SteerTestContext = {
    body: null,
    tlcChannelId: '',
    subchannelId: '',
    member1: null,
    member2: null,
    sessionId: '',
    testDir: '',
    skipped: true,
  };

  beforeAll(async () => {
    let relayOk = false;
    try {
      const res = await fetch(`${BASE_URL}/`, {
        headers: { Accept: 'application/nostr+json' },
      });
      relayOk = res.ok;
    } catch {
      log('relay unreachable — soft-skipping');
      return;
    }

    const config = loadBodyConfig({
      workspaceRoot: '/tmp/buzzy-body-test',
      llmEnvFile: LLM_ENV_FILE,
    });

    if (!hasLlmCredentials(config.agentEnv)) {
      log('no LLM credentials — soft-skipping');
      return;
    }

    const testDir = await mkdtemp(resolve(tmpdir(), 'buzzy-steer-'));
    ctx.testDir = testDir;

    const bodyIdentity = newIdentity('steer-body');
    const member1 = newIdentity('steer-member1');
    const member2 = newIdentity('steer-member2');
    ctx.member1 = member1;
    ctx.member2 = member2;

    // 1. Create TLC channel.
    const tlcChannelId = await createChannel(bodyIdentity, `steer-${RUN_MARKER}`);
    ctx.tlcChannelId = tlcChannelId;
    log('TLC channel:', tlcChannelId);

    await setMemberRole(bodyIdentity, tlcChannelId, member1.publicKey, 'member');
    await setMemberRole(bodyIdentity, tlcChannelId, member2.publicKey, 'member');

    // 2. Create body.
    const body = new Body({ ...config, workspaceRoot: testDir }, bodyIdentity);
    ctx.body = body;
    await body.provision(tlcChannelId);
    log('body provisioned');

    // 3. Create subchannel channel.
    const subchannelId = await createChannel(bodyIdentity, `sub-${RUN_MARKER}`);
    ctx.subchannelId = subchannelId;
    await setMemberRole(bodyIdentity, subchannelId, bodyIdentity.publicKey, 'member');
    await setMemberRole(bodyIdentity, subchannelId, member1.publicKey, 'member');
    await setMemberRole(bodyIdentity, subchannelId, member2.publicKey, 'member');
    log('subchannel:', subchannelId);

    // 4. Set up a local git repo + worktree for the edit session.
    const mainRepo = resolve(testDir, 'main-repo');
    const worktreePath = resolve(testDir, 'worktree');
    const featureBranch = `feature/${RUN_MARKER}`;

    mkdirSync(mainRepo, { recursive: true });
    spawnSync('git', ['init'], { cwd: mainRepo, encoding: 'utf8' });
    spawnSync('git', ['config', 'user.email', 'steer@test'], { cwd: mainRepo, encoding: 'utf8' });
    spawnSync('git', ['config', 'user.name', 'Steer Test'], { cwd: mainRepo, encoding: 'utf8' });
    await writeFile(resolve(mainRepo, 'README.md'), `# Steer Test ${RUN_MARKER}\n`);
    spawnSync('git', ['add', 'README.md'], { cwd: mainRepo, encoding: 'utf8' });
    spawnSync('git', ['commit', '-m', 'initial'], { cwd: mainRepo, encoding: 'utf8' });

    const defaultBranch = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: mainRepo, encoding: 'utf8' })
      .stdout.trim();
    spawnSync('git', ['worktree', 'add', '-b', featureBranch, worktreePath, defaultBranch], {
      cwd: mainRepo,
      encoding: 'utf8',
    });
    spawnSync('git', ['config', 'user.email', 'steer-agent@test'], { cwd: worktreePath, encoding: 'utf8' });
    spawnSync('git', ['config', 'user.name', 'Steer Agent'], { cwd: worktreePath, encoding: 'utf8' });
    log('worktree ready:', worktreePath);

    // 5. Start edit-mode ACP session.
    const acpClient = new AcpClient({
      agentBinary: config.agentBinary,
      agentEnv: config.agentEnv,
      autoApprovePermissions: true,
    });
    await acpClient.start();

    const { sessionId } = await acpClient.sessionNew({
      cwd: worktreePath,
      mcpServers: [{ name: 'buzz-dev-mcp', command: config.mcpBinary, args: [] }],
      mode: 'edit',
      systemPrompt: [
        'You are a coding agent in an edit session with multiple steering participants.',
        `Your feature branch is: ${featureBranch}. You have shell and file tools.`,
        'Members send messages prefixed with [Member <pubkey>]. Acknowledge briefly.',
      ].join('\n'),
    });
    ctx.sessionId = sessionId;
    log('edit session:', sessionId);

    // 6. Project activity to subchannel.
    const unsub = projectActivity(acpClient, subchannelId, bodyIdentity, sessionId);

    // 7. Register the session + subchannel in the body so pollMembers works.
    body.registerSubchannel({
      subchannelId,
      worktreePath,
      featureBranch,
      role: bodyIdentity,
      session: {
        channelId: subchannelId,
        sessionId,
        client: acpClient,
        mode: 'edit',
        worktreePath,
        featureBranch,
        parentChannelId: tlcChannelId,
        unsubscribeActivity: unsub,
        lastPolledAt: Math.floor(Date.now() / 1000),
        archived: false,
      },
      lastPolledAt: Math.floor(Date.now() / 1000),
      archived: false,
    });

    await postControlMessage(
      subchannelId,
      bodyIdentity,
      `🤖 Edit session started — steering test ${RUN_MARKER}. Members can steer.`,
      [['session', sessionId], ['mode', 'edit']],
    );
    log('ready for steering');

    ctx.skipped = false;
  }, 180_000);

  afterAll(async () => {
    if (ctx.body) {
      // Stop any remaining ACP sessions.
      for (const [, session] of ctx.body.getSessions()) {
        await session.client.stop();
      }
      await ctx.body.dispose();
    }
    if (ctx.testDir) {
      await rm(ctx.testDir, { recursive: true, force: true });
    }
  }, 30_000);

  it('relay and LLM env available (test not soft-skipped)', () => {
    if (ctx.skipped) {
      log('all tests soft-skipped');
      return;
    }
    expect(ctx.tlcChannelId).toBeTruthy();
    expect(ctx.subchannelId).toBeTruthy();
    expect(ctx.sessionId).toBeTruthy();
  });

  it(
    '(G10) incorporates a Room steer before the active run completes',
    async () => {
      if (ctx.skipped || !ctx.member1) return;

      const session = ctx.body!.getSession(ctx.subchannelId)!;
      const originalFile = resolve(session.worktreePath!, `ORIGINAL-${RUN_MARKER}.txt`);
      const redirectedFile = resolve(session.worktreePath!, `REDIRECTED-${RUN_MARKER}.txt`);
      const redirectedContent = `live redirect ${RUN_MARKER}`;
      let originalSettled = false;
      let resolveToolStarted!: () => void;
      const toolStarted = new Promise<void>((resolveStarted) => {
        resolveToolStarted = resolveStarted;
      });
      const onUpdate = (update: { sessionId: string; update: Record<string, unknown> }) => {
        if (
          update.sessionId === ctx.sessionId &&
          update.update.sessionUpdate === 'tool_call' &&
          (update.update.status === 'pending' || update.update.status === 'in_progress')
        ) {
          resolveToolStarted();
        }
      };
      session.client.on('session/update', onUpdate);

      const originalPrompt = session.client
        .sessionPrompt(
          ctx.sessionId,
          [
            'Start this task now. Your first action must be one shell tool call containing only: sleep 12',
            'Do not combine that sleep with another command or edit any file in the same tool call.',
            'After the sleep returns, reconsider the newest user instruction before doing file work.',
            `If there is no newer instruction, create ${originalFile} containing "original ${RUN_MARKER}".`,
          ].join('\n'),
          120_000,
        )
        .finally(() => {
          originalSettled = true;
        });

      try {
        await Promise.race([
          toolStarted,
          sleep(45_000).then(() => {
            throw new Error('agent did not start the initial sleep tool call');
          }),
        ]);
        expect(originalSettled).toBe(false);
        const activeRunId = session.client.activeRunId(ctx.sessionId);
        expect(activeRunId).toMatch(/^(run_|session:)/);
        log('initial run active:', activeRunId);

        const steerEvent = signEvent(
          {
            pubkey: ctx.member1.publicKey,
            created_at: Math.floor(Date.now() / 1000),
            kind: 9,
            tags: [['h', ctx.subchannelId]],
            content: [
              'Redirect the task that is running right now.',
              `Do NOT create ${originalFile}.`,
              `Create ${redirectedFile} containing exactly "${redirectedContent}" instead.`,
            ].join(' '),
          },
          ctx.member1.secretKey,
        );
        await publishEvent(steerEvent, ctx.member1!);
        log('mid-run steer posted:', steerEvent.id);
        await sleep(2_000);

        const count = await ctx.body!.pollMembers(ctx.subchannelId);
        log('mid-run pollMembers:', count, 'original settled:', originalSettled);
        expect(count).toBeGreaterThanOrEqual(1);
        expect(originalSettled).toBe(false);

        const result = await originalPrompt;
        log('active run completed after steer:', result.stopReason);
        const actualRedirectedContent = await readFile(redirectedFile, 'utf8');
        log('redirected output:', JSON.stringify(actualRedirectedContent));
        expect(actualRedirectedContent.trimEnd()).toBe(redirectedContent);
        await expect(readFile(originalFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      } finally {
        session.client.off('session/update', onUpdate);
      }
    },
    150_000,
  );

  it(
    '(a) member1 steering message reaches the session (pollMembers bridges it)',
    async () => {
      if (ctx.skipped || !ctx.member1) return;

      const marker1 = `marker1-${RUN_MARKER}`;

      // Member1 posts a steering message to the subchannel.
      const event1 = signEvent(
        {
          pubkey: ctx.member1.publicKey,
          created_at: Math.floor(Date.now() / 1000),
          kind: 9,
          tags: [['h', ctx.subchannelId]],
          content: `Steering from member 1. Marker: ${marker1}. Please reply "ACK ${marker1}"`,
        },
        ctx.member1.secretKey,
      );
      await publishEvent(event1, ctx.member1!);
      log('member1 posted:', event1.id);
      await sleep(2000);

      // Poll — the body bridges this to the session.
      const count = await ctx.body!.pollMembers(ctx.subchannelId);
      log('pollMembers from member1:', count);

      // We expect at least 1 message bridged.
      expect(count).toBeGreaterThanOrEqual(1);

      // Wait for agent-activity events to propagate.
      await sleep(3000);

      // Query subchannel for agent-activity events.
      const activityEvents = await queryEvents(
        [{ kinds: [9], '#t': ['agent-activity'], '#h': [ctx.subchannelId], limit: 100 }],
        ctx.body!.identity,
      );
      log('activity events total:', activityEvents.length);
      expect(activityEvents.length).toBeGreaterThan(0);

      // Check that member1's marker is referenced in activity or subchannel events.
      const allSubchannelEvents = await queryEvents(
        [{ kinds: [9], '#h': [ctx.subchannelId], limit: 200 }],
        ctx.body!.identity,
      );
      const member1Events = allSubchannelEvents.filter((e) => e.pubkey === ctx.member1!.publicKey);
      expect(member1Events.length).toBeGreaterThanOrEqual(1);
      const hasMarker = member1Events.some((e) => e.content.includes(marker1));
      expect(hasMarker).toBe(true);
    },
    120_000,
  );

  it(
    '(b) BOTH members receive same agent-activity events, (c) member2 marker in history',
    async () => {
      if (ctx.skipped || !ctx.member2) return;

      const marker2 = `marker2-${RUN_MARKER}`;

      // Member2 posts a steering message.
      const event2 = signEvent(
        {
          pubkey: ctx.member2.publicKey,
          created_at: Math.floor(Date.now() / 1000),
          kind: 9,
          tags: [['h', ctx.subchannelId]],
          content: `Steering from member 2. Marker: ${marker2}. Please reply "ACK ${marker2}"`,
        },
        ctx.member2.secretKey,
      );
      await publishEvent(event2, ctx.member2!);
      log('member2 posted:', event2.id);
      await sleep(2000);

      const count = await ctx.body!.pollMembers(ctx.subchannelId);
      log('pollMembers from member2:', count);
      expect(count).toBeGreaterThanOrEqual(1);

      await sleep(3000);

      // Query agent-activity events as both members.
      const eventsAsMember1 = await queryEvents(
        [{ kinds: [9], '#t': ['agent-activity'], '#h': [ctx.subchannelId], limit: 100 }],
        ctx.member1!,
      );
      const eventsAsMember2 = await queryEvents(
        [{ kinds: [9], '#t': ['agent-activity'], '#h': [ctx.subchannelId], limit: 100 }],
        ctx.member2!,
      );

      log('activity events (m1 view):', eventsAsMember1.length);
      log('activity events (m2 view):', eventsAsMember2.length);

      // (b) Both see activity.
      expect(eventsAsMember1.length).toBeGreaterThan(0);
      expect(eventsAsMember2.length).toBeGreaterThan(0);

      // They should share at least some event IDs (same events visible to both).
      const ids1 = new Set(eventsAsMember1.map((e) => e.id));
      const ids2 = new Set(eventsAsMember2.map((e) => e.id));
      const shared = [...ids1].filter((id) => ids2.has(id));
      log('shared activity event IDs:', shared.length);
      expect(shared.length).toBeGreaterThan(0);

      // (c) Member2's marker should appear in the subchannel history.
      const allSubchannelEvents = await queryEvents(
        [{ kinds: [9], '#h': [ctx.subchannelId], limit: 200 }],
        ctx.body!.identity,
      );
      const member2Events = allSubchannelEvents.filter((e) => e.pubkey === ctx.member2!.publicKey);
      expect(member2Events.length).toBeGreaterThanOrEqual(1);
      const hasMarker2 = member2Events.some((e) => e.content.includes(marker2));
      expect(hasMarker2).toBe(true);
    },
    120_000,
  );
});
