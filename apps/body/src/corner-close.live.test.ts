/**
 * Live relay proof for the human "CLOSE CORNER" action: a `#t=buzz-corner-close`
 * message inside a corner must archive that subchannel outright (kind:9002 →
 * kind:39000 archived=true), not merely cancel the active turn — distinct from
 * `#t=buzz-agent-cancel`, which only stops the current turn and leaves the
 * corner open. Soft-skips when the relay is unreachable; no LLM/ACP runtime
 * is needed since the subchannel state is registered directly (the same seam
 * `registerSubchannel`/`registerSession` expose for tests).
 */
import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  BASE_URL,
  HOST,
  createChannel,
  newIdentity,
  queryEvents,
  setMemberRole,
} from '@beeline/gate';
import { createBuzzClient } from '@beeline/buzz-client';
import { Body, createAgentSubchannel, type SubchannelInfo } from './body.js';
import { loadBodyConfig } from './config.js';

async function reachable(): Promise<boolean> {
  try {
    const response = await fetch(`${BASE_URL}/health`, {
      headers: { host: HOST },
      signal: AbortSignal.timeout(3_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitUntil(check: () => Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await check()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}

const live = await reachable();

describe.runIf(live)('live corner close (archive) contract', () => {
  it('10. close travels the existing socket path and archives exactly once without a poll tick', async () => {
    const human = newIdentity('corner-close-human');
    const agent = newIdentity('corner-close-agent');
    const parentChannelId = await createChannel(human, `corner-close-${Date.now()}`);
    await setMemberRole(human, parentChannelId, agent.publicKey, 'member');

    const testDir = await mkdtemp(resolve(tmpdir(), 'beeline-corner-close-'));
    const body = new Body(loadBodyConfig({ workspaceRoot: testDir }), human, agent);

    try {
      const subchannelId = await createAgentSubchannel(
        agent,
        parentChannelId,
        `corner-close-sub-${Date.now()}`,
        human.publicKey,
      );

      const sessionCancel = vi.fn();
      const info: SubchannelInfo = {
        subchannelId,
        worktreePath: resolve(testDir, 'nonexistent-worktree'),
        featureBranch: 'feature/corner-close-test',
        role: agent,
        session: {
          channelId: subchannelId,
          parentChannelId,
          sessionId: 'corner-close-session',
          mode: 'edit',
          archived: false,
          lastPolledAt: 0,
          client: { sessionCancel, stop: vi.fn(async () => undefined) } as never,
        } as never,
        lastPolledAt: 0,
        archived: false,
      };
      body.registerSubchannel(info);

      const humanClient = createBuzzClient({ baseUrl: BASE_URL, identity: human });
      await humanClient.messageSubmit(subchannelId, 'Close this corner.', {
        extraTags: [['t', 'buzz-corner-close']],
      });

      const processed = await body.pollMembers(subchannelId);
      expect(processed).toBe(1);

      // The active turn is cancelled as part of archiving (not a separate step).
      expect(sessionCancel).toHaveBeenCalledWith('corner-close-session');

      await waitUntil(async () => {
        const metadata = await queryEvents(
          [{ kinds: [39000], '#d': [subchannelId], limit: 5 }],
          human,
        );
        return metadata.some((event) =>
          event.tags.some((tag) => tag[0] === 'archived' && tag[1] === 'true'),
        );
      });

      const parentEvents = await queryEvents(
        [{ kinds: [9], '#h': [parentChannelId], limit: 50 }],
        human,
      );
      expect(
        parentEvents.some((event) =>
          event.tags.some((tag) => tag[0] === 'subchannel' && tag[1] === subchannelId),
        ),
      ).toBe(true);

      humanClient.disconnect();
    } finally {
      await body.dispose();
      await rm(testDir, { recursive: true, force: true });
    }
  }, 30_000);

  it('aborts an in-flight turn on close and publishes nothing further for that corner', async () => {
    const human = newIdentity('corner-close-race-human');
    const agent = newIdentity('corner-close-race-agent');
    const parentChannelId = await createChannel(human, `corner-close-race-${Date.now()}`);
    await setMemberRole(human, parentChannelId, agent.publicKey, 'member');

    const testDir = await mkdtemp(resolve(tmpdir(), 'beeline-corner-close-race-'));
    const body = new Body(loadBodyConfig({ workspaceRoot: testDir }), human, agent);

    try {
      const subchannelId = await createAgentSubchannel(
        agent,
        parentChannelId,
        `corner-close-race-sub-${Date.now()}`,
        human.publicKey,
      );

      const publishSpy = vi.spyOn(body as never, 'publishAgentResult' as never);

      const sessionCancel = vi.fn();
      // Simulates the maintenance-tick race (`ROOM_WS_MAINTENANCE_TICK_MS`
      // overlap): a `#t=buzz-corner-close` seen by another poll archives the
      // corner while this turn is still resolving. The turn then completes
      // normally — the guard is what must stop its reply from publishing.
      const sessionPrompt = vi.fn(async () => {
        await body.archiveSubchannel(subchannelId);
        return {
          stopReason: 'end_turn',
          updates: [],
          agentText: 'TRAILING SUMMARY MUST NOT PUBLISH',
          toolCalls: [],
        };
      });
      const info: SubchannelInfo = {
        subchannelId,
        worktreePath: resolve(testDir, 'nonexistent-worktree'),
        featureBranch: 'feature/corner-close-race-test',
        role: agent,
        session: {
          channelId: subchannelId,
          parentChannelId,
          sessionId: 'corner-close-race-session',
          mode: 'edit',
          archived: false,
          lastPolledAt: 0,
          client: {
            sessionCancel,
            stop: vi.fn(async () => undefined),
            activeRunId: vi.fn(() => undefined),
            sessionPrompt,
          } as never,
        } as never,
        lastPolledAt: 0,
        archived: false,
      };
      body.registerSubchannel(info);

      const humanClient = createBuzzClient({ baseUrl: BASE_URL, identity: human });
      await humanClient.messageSubmit(subchannelId, 'Please also fix the retry logic.');

      const processed = await body.pollMembers(subchannelId);
      expect(processed).toBe(1);

      // The turn ran and resolved normally, but archival won the race — the
      // corner is closed and nothing further was ever published for it.
      expect(sessionPrompt).toHaveBeenCalled();
      expect(sessionCancel).toHaveBeenCalledWith('corner-close-race-session');
      expect(publishSpy).not.toHaveBeenCalled();
      expect(info.archived).toBe(true);

      await waitUntil(async () => {
        const metadata = await queryEvents(
          [{ kinds: [39000], '#d': [subchannelId], limit: 5 }],
          human,
        );
        return metadata.some((event) =>
          event.tags.some((tag) => tag[0] === 'archived' && tag[1] === 'true'),
        );
      });

      const subchannelEvents = await queryEvents(
        [{ kinds: [9], '#h': [subchannelId], limit: 50 }],
        human,
      );
      expect(
        subchannelEvents.some((event) => event.content.includes('TRAILING SUMMARY')),
      ).toBe(false);

      humanClient.disconnect();
    } finally {
      await body.dispose();
      await rm(testDir, { recursive: true, force: true });
    }
  }, 30_000);
});

if (!live) {
  describe('live corner close (archive) contract (prerequisites)', () => {
    it('SKIPPED — requires the local relay stack only; no LLM credentials are used', () => {
      console.warn('Start with `npm run stack:up` at the repository root.');
    });
  });
}
