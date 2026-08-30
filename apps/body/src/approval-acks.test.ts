/**
 * Approval consumption + acknowledgement (the 2026-08-23 live hang).
 *
 * The owner tapped APPROVE; the signed event sat on the relay while
 * `findHumanMergeApproval` skipped every non-matching tip with a quiet
 * `continue`, and nothing anywhere acknowledged acceptance — so the app's
 * DELIVERING state spun forever. These tests pin the new contract:
 *
 *   - a matching approval is consumed AND acknowledged (`decision=accepted`),
 *     exactly once per approval id;
 *   - an authority-verified approval remains standing for this corner when
 *     later commits move its work tip;
 *   - an approval from another corner is never accepted;
 *   - the end-to-end land path still works with the ack in place.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { signEvent } from '@beeline/nostr';
import { buildApproval as gateBuildApproval, newIdentity } from '@beeline/gate';
import type { NostrEvent } from '@beeline/nostr';
import { Body } from './body.js';
import { APPROVAL_ACK_TAG, CORNER_CLOSE_TAG } from './body.js';
import { filterRelayEvents, mediaUploadResponse } from './relay-test-helper.js';

const KIND_CHANNEL_ADMINS = 39001;

function gitCommand(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

function localOnlyRepoWithCorner(): {
  root: string;
  repoPath: string;
  cornerPath: string;
  tip: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'buzzy-approval-ack-'));
  const repoPath = join(root, 'repo');
  const cornerPath = join(root, 'corner');
  mkdirSync(repoPath, { recursive: true });
  gitCommand(repoPath, ['init', '-b', 'master']);
  gitCommand(repoPath, ['config', 'user.name', 'Approval Ack Test']);
  gitCommand(repoPath, ['config', 'user.email', 'ack@test.invalid']);
  writeFileSync(join(repoPath, 'README.md'), '# Before\n');
  gitCommand(repoPath, ['add', '.']);
  gitCommand(repoPath, ['commit', '-m', 'base']);
  gitCommand(repoPath, ['worktree', 'add', '-b', 'feature/haiku', cornerPath, 'master']);
  gitCommand(cornerPath, ['config', 'user.name', 'Ack Agent']);
  gitCommand(cornerPath, ['config', 'user.email', 'agent@test.invalid']);
  writeFileSync(join(cornerPath, 'README.md'), '# Before\n\nan old silent pond\n');
  gitCommand(cornerPath, ['add', 'README.md']);
  gitCommand(cornerPath, ['commit', '-m', 'add a haiku']);
  return { root, repoPath, cornerPath, tip: gitCommand(cornerPath, ['rev-parse', 'HEAD']) };
}

function mkdir(path: string): void {
  const { mkdirSync } = require('node:fs') as typeof import('node:fs');
  mkdirSync(path, { recursive: true });
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
  tip: string,
) {
  return {
    subchannelId: 'corner-ack',
    worktreePath: cornerPath,
    featureBranch: 'feature/haiku',
    role: agent,
    session: {
      channelId: 'corner-ack',
      parentChannelId: 'room-ack',
      sessionId: 'session',
    } as never,
    lastPolledAt: 0,
    archived: false,
    boundRepo: {
      repo: 'proj',
      repositoryKey: 'local-key',
      localOnly: true,
      localPath: repoPath,
      targetBranch: 'refs/heads/master',
    },
    mergeTarget: { repo: 'local/local-key', branch: 'refs/heads/master', tip },
  };
}

function buildApproval(
  reviewer: ReturnType<typeof newIdentity>,
  tip: string,
  patchId?: string,
): NostrEvent {
  // The canonical builder (same wire shape mobile signs), so the daemon's own
  // `verifyApproval` accepts it exactly as it does in production.
  return gateBuildApproval(reviewer, 'corner-ack', {
    repo: 'local/local-key',
    branch: 'refs/heads/master',
    tip,
    ...(patchId ? { patchId } : {}),
  });
}

/** Relay stub answering approval scans, admin projections (reviewer is a human
 *  admin), and agent-registry lookups (the reviewer is NOT an agent). */
function stubAgentRelay(approvals: NostrEvent[], adminPubkeys: string[]) {
  const published: NostrEvent[] = [];
  const adminProjection = signEvent(
    {
      pubkey: adminPubkeys[0] ?? 'a'.repeat(64),
      created_at: Math.floor(Date.now() / 1000),
      kind: KIND_CHANNEL_ADMINS,
      tags: [['d', 'corner-ack'], ...adminPubkeys.map((pubkey) => ['p', pubkey, 'admin'])],
      content: '',
    },
    // The projection's own signature is not verified by resolveChannelRole.
    newIdentity('projection-author').secretKey,
  );
  return {
    queryEvents: async (filters: Record<string, unknown>[]) => {
      const filter = filters[0] ?? {};
      const kinds = (filter.kinds as number[] | undefined) ?? [];
      if ((filter['#t'] as string[] | undefined)?.includes('buzz-merge-approval')) {
        return approvals;
      }
      if (kinds.includes(KIND_CHANNEL_ADMINS)) return [adminProjection];
      if (kinds.includes(30078)) return filterRelayEvents(published, filters);
      // Agent-identity registry lookup for the reviewer: empty → human.
      return [];
    },
    publishEvent: async (event: NostrEvent) => {
      published.push(event);
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('approval consumption acknowledges the human', () => {
  it('publishes decision=accepted on the corner channel, once per approval id', async () => {
    const agent = newIdentity('ack-agent-once');
    const reviewer = newIdentity('ack-reviewer-once');
    const { root, repoPath, cornerPath, tip } = localOnlyRepoWithCorner();
    const published: NostrEvent[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const body = JSON.parse(String(init?.body)) as NostrEvent;
        if (url.includes('/query') || body.kind !== 9 || !Array.isArray(body.tags)) {
          return new Response(JSON.stringify([]), { status: 200 });
        }
        published.push(body);
        return new Response(JSON.stringify({ accepted: true }), { status: 200 });
      }),
    );
    try {
      const body = newBody(agent, join(root, 'state.json'));
      const info = cornerInfo(agent, repoPath, cornerPath, tip);
      body.registerSubchannel(info as never);
      const approval = buildApproval(reviewer, tip);
      Reflect.set(body, 'agentRelay', stubAgentRelay([approval], [reviewer.publicKey]));

      const find = Reflect.get(body, 'findHumanMergeApproval').bind(body);
      await find(info);
      await find(info);
      await find(info);

      const acks = published.filter((event) =>
        event.tags.some((tag) => tag[0] === 't' && tag[1] === APPROVAL_ACK_TAG),
      );
      expect(acks.length).toBe(1);
      expect(acks[0]!.tags).toContainEqual(['decision', 'accepted']);
      expect(acks[0]!.tags).toContainEqual(['approval', approval.id]);
      expect(acks[0]!.tags).toContainEqual(['h', 'corner-ack']);
      expect(acks[0]!.content).toContain('Approval received');
      expect(info.cornerState).toEqual({ state: 'working' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps approval standing when the same corner adds commits B and C, then lands tip C', async () => {
    const agent = newIdentity('ack-agent-stale');
    const reviewer = newIdentity('ack-reviewer-stale');
    const { root, repoPath, cornerPath, tip: approvedTip } = localOnlyRepoWithCorner();
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
      const approval = buildApproval(reviewer, approvedTip, 'c'.repeat(40));

      writeFileSync(join(cornerPath, 'B.txt'), 'commit B\n');
      gitCommand(cornerPath, ['add', 'B.txt']);
      gitCommand(cornerPath, ['commit', '-m', 'add commit B']);
      writeFileSync(join(cornerPath, 'C.txt'), 'commit C\n');
      gitCommand(cornerPath, ['add', 'C.txt']);
      gitCommand(cornerPath, ['commit', '-m', 'add commit C']);
      const currentTip = gitCommand(cornerPath, ['rev-parse', 'HEAD']);

      const info = cornerInfo(agent, repoPath, cornerPath, currentTip);
      info.mergeTarget = { ...info.mergeTarget, patchId: 'd'.repeat(40) };
      body.registerSubchannel(info as never);
      Reflect.set(body, 'agentRelay', stubAgentRelay([approval], [reviewer.publicKey]));
      Reflect.set(body, 'realignCornersForRepo', async () => 0);

      const landed = await Reflect.get(body, 'pollDirectRemoteApprovals').call(body);

      expect(landed).toBe(1);
      expect(gitCommand(repoPath, ['rev-parse', 'refs/heads/master'])).toBe(currentTip);
      expect(info.humanMergeApproval).toMatchObject({
        id: approval.id,
        approvedTip,
        tip: currentTip,
      });
      expect(
        published.some((event) =>
          event.tags.some((tag) => tag[0] === 'decision' && tag[1] === 'rejected'),
        ),
      ).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not accept an approval signed for a different corner', async () => {
    const agent = newIdentity('ack-agent-other-corner');
    const reviewer = newIdentity('ack-reviewer-other-corner');
    const { root, repoPath, cornerPath, tip } = localOnlyRepoWithCorner();
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
      const info = cornerInfo(agent, repoPath, cornerPath, tip);
      body.registerSubchannel(info as never);
      const otherCornerApproval = gateBuildApproval(reviewer, 'corner-other', {
        repo: 'local/local-key',
        branch: 'refs/heads/master',
        tip,
      });
      Reflect.set(body, 'agentRelay', stubAgentRelay([otherCornerApproval], [reviewer.publicKey]));

      const found = await Reflect.get(body, 'findHumanMergeApproval').call(body, info);

      expect(found).toBeUndefined();
      expect(published).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('consumes an approval end to end: ack, then land, then landed card', async () => {
    const agent = newIdentity('ack-agent-e2e');
    const reviewer = newIdentity('ack-reviewer-e2e');
    const { root, repoPath, cornerPath, tip } = localOnlyRepoWithCorner();
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
      const info = cornerInfo(agent, repoPath, cornerPath, tip);
      body.registerSubchannel(info as never);
      const approval = buildApproval(reviewer, tip);
      Reflect.set(body, 'agentRelay', stubAgentRelay([approval], [reviewer.publicKey]));
      // No other corners to realign; keep the fire-and-forget hook inert.
      Reflect.set(body, 'realignCornersForRepo', async () => 0);

      const landed = await Reflect.get(body, 'pollDirectRemoteApprovals').call(body);

      expect(landed).toBe(1);
      expect(gitCommand(repoPath, ['rev-parse', 'refs/heads/master'])).toBe(tip);
      expect(
        published.some((event) =>
          event.tags.some((tag) => tag[0] === 't' && tag[1] === APPROVAL_ACK_TAG),
        ),
      ).toBe(true);
      expect(
        published.some((event) => event.tags.some((tag) => tag[0] === 't' && tag[1] === 'landed')),
      ).toBe(true);
      expect(
        published.some((event) =>
          event.tags.some((tag) => tag[0] === 'approval' && tag[1] === approval.id),
        ),
      ).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('falls back from a tenant-drift 404 to the working shipped relay authority', async () => {
    const agent = newIdentity('ack-agent-tenant-fallback');
    const reviewer = newIdentity('ack-reviewer-tenant-fallback');
    const { root, repoPath, cornerPath, tip } = localOnlyRepoWithCorner();
    const approval = buildApproval(reviewer, tip);
    const published: NostrEvent[] = [];
    const fallbackRelay = stubAgentRelay([approval], [reviewer.publicKey]);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith('/query')) {
          const filters = JSON.parse(String(init?.body)) as Record<string, unknown>[];
          return new Response(JSON.stringify(await fallbackRelay.queryEvents(filters)), {
            status: 200,
          });
        }
        published.push(JSON.parse(String(init?.body)) as NostrEvent);
        return new Response(JSON.stringify({ accepted: true }), { status: 200 });
      }),
    );
    try {
      const body = newBody(agent, join(root, 'state.json'));
      const info = cornerInfo(agent, repoPath, cornerPath, tip);
      body.registerSubchannel(info as never);
      const primary = stubAgentRelay([], [reviewer.publicKey]);
      Reflect.set(body, 'agentRelay', {
        ...primary,
        queryEvents: async (filters: Record<string, unknown>[]) => {
          if ((filters[0]?.['#t'] as string[] | undefined)?.includes('buzz-merge-approval')) {
            throw new Error(
              'queryEvents failed: HTTP 404 relay: no community is configured for this host',
            );
          }
          return primary.queryEvents(filters);
        },
      });

      const found = await Reflect.get(body, 'findHumanMergeApproval').call(body, info);

      expect(found?.id).toBe(approval.id);
      expect(
        published.some((event) =>
          event.tags.some((tag) => tag[0] === 'decision' && tag[1] === 'accepted'),
        ),
      ).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('surfaces an approval-read outage once and auto-honors the standing grant on recovery', async () => {
    const agent = newIdentity('ack-agent-tenant-recovery');
    const reviewer = newIdentity('ack-reviewer-tenant-recovery');
    const { root, repoPath, cornerPath, tip } = localOnlyRepoWithCorner();
    const approval = buildApproval(reviewer, tip);
    const published: NostrEvent[] = [];
    let fallbackReads = 0;
    const fallbackRelay = stubAgentRelay([approval], [reviewer.publicKey]);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith('/query')) {
          fallbackReads++;
          if (fallbackReads <= 2) {
            return new Response('relay: no community is configured for this host', { status: 404 });
          }
          const filters = JSON.parse(String(init?.body)) as Record<string, unknown>[];
          return new Response(JSON.stringify(await fallbackRelay.queryEvents(filters)), {
            status: 200,
          });
        }
        published.push(JSON.parse(String(init?.body)) as NostrEvent);
        return new Response(JSON.stringify({ accepted: true }), { status: 200 });
      }),
    );
    try {
      const body = newBody(agent, join(root, 'state.json'));
      const info = cornerInfo(agent, repoPath, cornerPath, tip);
      body.registerSubchannel(info as never);
      const primary = stubAgentRelay([], [reviewer.publicKey]);
      Reflect.set(body, 'agentRelay', {
        ...primary,
        queryEvents: async (filters: Record<string, unknown>[]) => {
          if ((filters[0]?.['#t'] as string[] | undefined)?.includes('buzz-merge-approval')) {
            throw new Error(
              'queryEvents failed: HTTP 404 relay: no community is configured for this host',
            );
          }
          return primary.queryEvents(filters);
        },
      });

      await Reflect.get(body, 'findHumanMergeApproval').call(body, info);
      await Reflect.get(body, 'findHumanMergeApproval').call(body, info);
      expect(info.cornerState).toEqual({ state: 'working' });
      Reflect.set(body, 'realignCornersForRepo', async () => 0);
      const landed = await Reflect.get(body, 'pollDirectRemoteApprovals').call(body);

      const failures = published.filter((event) =>
        event.tags.some((tag) => tag[0] === 'delivery' && tag[1] === 'approval-read-failed'),
      );
      expect(failures).toHaveLength(1);
      expect(failures[0]!.content).toContain('no community is configured for this host');
      expect(failures[0]!.content).toContain('honor it automatically');
      expect(landed).toBe(1);
      expect(gitCommand(repoPath, ['rev-parse', 'refs/heads/master'])).toBe(tip);
      expect(info.lastApprovalReadFailure).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('realigns a pure rebase and lands with the existing corner approval', async () => {
    const agent = newIdentity('ack-agent-realigned');
    const reviewer = newIdentity('ack-reviewer-realigned');
    const { root, repoPath, cornerPath, tip } = localOnlyRepoWithCorner();
    const approvedTip = 'a'.repeat(40);
    const patchId = 'c'.repeat(40);
    const approval = buildApproval(reviewer, approvedTip, patchId);
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
      const info = cornerInfo(agent, repoPath, cornerPath, tip);
      info.mergeTarget = { ...info.mergeTarget, patchId };
      body.registerSubchannel(info as never);
      Reflect.set(body, 'agentRelay', stubAgentRelay([approval], [reviewer.publicKey]));

      const found = await Reflect.get(body, 'findHumanMergeApproval').call(body, info);

      expect(found).toMatchObject({ id: approval.id, tip, approvedTip, patchId, realigned: true });
      const ack = published.find((event) =>
        event.tags.some((tag) => tag[0] === 'state' && tag[1] === 'realigned'),
      );
      expect(ack?.content).toContain('existing approval');
      expect(ack?.tags).toContainEqual(['approved-tip', approvedTip]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps the corner approval standing when later work changes the patch', async () => {
    const agent = newIdentity('ack-agent-content-changed');
    const reviewer = newIdentity('ack-reviewer-content-changed');
    const { root, repoPath, cornerPath, tip } = localOnlyRepoWithCorner();
    const approval = buildApproval(reviewer, 'a'.repeat(40), 'c'.repeat(40));
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
      const info = cornerInfo(agent, repoPath, cornerPath, tip);
      info.mergeTarget = { ...info.mergeTarget, patchId: 'd'.repeat(40) };
      body.registerSubchannel(info as never);
      Reflect.set(body, 'agentRelay', stubAgentRelay([approval], [reviewer.publicKey]));

      const found = await Reflect.get(body, 'findHumanMergeApproval').call(body, info);

      expect(found).toMatchObject({
        id: approval.id,
        approvedTip: 'a'.repeat(40),
        tip,
      });
      expect(
        published.some((event) =>
          event.tags.some((tag) => tag[0] === 'decision' && tag[1] === 'rejected'),
        ),
      ).toBe(false);
      expect(info.cornerState).toEqual({ state: 'working' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('event-driven approval pickup', () => {
  async function readyCorner(options: { suspended?: boolean } = {}) {
    const agent = newIdentity(`wake-agent-${options.suspended ? 'suspended' : 'live'}`);
    const reviewer = newIdentity(`wake-reviewer-${options.suspended ? 'suspended' : 'live'}`);
    const fixture = localOnlyRepoWithCorner();
    const published: NostrEvent[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const upload = mediaUploadResponse(input, init);
        if (upload) return upload;
        published.push(JSON.parse(String(init?.body)) as NostrEvent);
        return new Response(JSON.stringify({ accepted: true }), { status: 200 });
      }),
    );
    const body = newBody(agent, join(fixture.root, 'state.json'));
    const info = cornerInfo(agent, fixture.repoPath, fixture.cornerPath, fixture.tip);
    info.mergeTarget = undefined as never;
    if (options.suspended) info.session.processState = 'suspended';
    body.registerSubchannel(info as never);
    const approvals: NostrEvent[] = [];
    Reflect.set(body, 'agentRelay', stubAgentRelay(approvals, [reviewer.publicKey]));
    await expect(Reflect.get(body, 'publishMergeReady').call(body, info)).resolves.toBe(true);
    const approval = buildApproval(reviewer, fixture.tip, info.mergeTarget?.patchId);
    return { ...fixture, body, info, approval, approvals, published, reviewer };
  }

  function activityStages(events: NostrEvent[]): string[] {
    return events
      .filter((event) => event.tags?.some((tag) => tag[0] === 't' && tag[1] === 'agent-activity'))
      .map((event) => event.tags.find((tag) => tag[0] === 'delivery-stage')?.[1])
      .filter((stage): stage is string => Boolean(stage));
  }

  it('lands from the pushed corner approval and publishes the ack without a maintenance sleep', async () => {
    const fixture = await readyCorner();
    const handlers = new Map<string, (event: NostrEvent) => void>();
    const subscriptions = new Map<string, () => void>();
    const mergeGate = { poll: vi.fn(async () => []) };
    Reflect.set(
      fixture.body,
      'pollMergeCompletions',
      vi.fn(async () => undefined),
    );
    const client = {
      sessionEventsSubscribe: vi.fn(
        async (
          channelId: string,
          handler: typeof handlers extends Map<string, infer H> ? H : never,
        ) => {
          handlers.set(channelId, handler);
          return () => handlers.delete(channelId);
        },
      ),
    };
    try {
      await Reflect.get(fixture.body, 'syncCornerApprovalSubscriptions').call(
        fixture.body,
        'room-ack',
        client,
        mergeGate,
        subscriptions,
      );
      expect(handlers.has('corner-ack')).toBe(true);

      handlers.get('corner-ack')!(fixture.approval);

      await vi.waitFor(
        () => {
          expect(
            fixture.published.some((event) =>
              event.tags.some((tag) => tag[0] === 't' && tag[1] === APPROVAL_ACK_TAG),
            ),
          ).toBe(true);
          expect(activityStages(fixture.published)).toContain('approval-received');
        },
        { timeout: 2_000 },
      );
      await vi.waitFor(() => expect(fixture.info.landedTip).toBe(fixture.tip), { timeout: 10_000 });
      await vi.waitFor(
        () => expect(Reflect.get(fixture.body, 'approvalLandingPasses').size).toBe(0),
        { timeout: 5_000 },
      );
      expect(
        fixture.published.some((event) =>
          event.tags.some((tag) => tag[0] === 't' && tag[1] === APPROVAL_ACK_TAG),
        ),
      ).toBe(true);
      expect(activityStages(fixture.published)).toEqual(
        expect.arrayContaining(['approval-received', 'running-gate', 'pushing', 'landed']),
      );
      expect(mergeGate.poll).toHaveBeenCalledWith([fixture.approval], expect.any(Object));
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('archives once for two pushed close events without waiting for the maintenance poll', async () => {
    const fixture = await readyCorner();
    const handlers = new Map<string, (event: NostrEvent) => void>();
    const subscriptions = new Map<string, () => void>();
    const client = {
      sessionEventsSubscribe: vi.fn(
        async (channelId: string, handler: (event: NostrEvent) => void) => {
          handlers.set(channelId, handler);
          return () => handlers.delete(channelId);
        },
      ),
    };
    const archive = vi.fn(async () => {
      fixture.info.archived = true;
    });
    fixture.body.archiveSubchannel = archive;
    const maintenancePoll = vi.spyOn(fixture.body, 'pollMembers');
    const close = (createdAt: number) =>
      signEvent(
        {
          pubkey: fixture.reviewer.publicKey,
          created_at: createdAt,
          kind: 9,
          tags: [
            ['h', 'corner-ack'],
            ['t', CORNER_CLOSE_TAG],
          ],
          content: 'Close this corner.',
        },
        fixture.reviewer.secretKey,
      );

    try {
      await Reflect.get(fixture.body, 'syncCornerApprovalSubscriptions').call(
        fixture.body,
        'room-ack',
        client,
        undefined,
        subscriptions,
      );
      handlers.get('corner-ack')!(close(100));
      handlers.get('corner-ack')!(close(101));

      await vi.waitFor(() => expect(archive).toHaveBeenCalledTimes(1));
      expect(maintenancePoll).not.toHaveBeenCalled();
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('lands identically while the harness session is suspended', async () => {
    const fixture = await readyCorner({ suspended: true });
    const prompt = vi.spyOn(fixture.body as never, 'promptAgent' as never);
    const handlers = new Map<string, (event: NostrEvent) => void>();
    const subscriptions = new Map<string, () => void>();
    const client = {
      sessionEventsSubscribe: vi.fn(
        async (channelId: string, handler: (event: NostrEvent) => void) => {
          handlers.set(channelId, handler);
          return () => handlers.delete(channelId);
        },
      ),
    };
    try {
      await Reflect.get(fixture.body, 'syncCornerApprovalSubscriptions').call(
        fixture.body,
        'room-ack',
        client,
        undefined,
        subscriptions,
      );
      handlers.get('corner-ack')!(fixture.approval);

      await vi.waitFor(
        () => expect(activityStages(fixture.published)).toContain('approval-received'),
        { timeout: 2_000 },
      );
      await vi.waitFor(() => expect(fixture.info.landedTip).toBe(fixture.tip), { timeout: 10_000 });
      await vi.waitFor(
        () => expect(Reflect.get(fixture.body, 'approvalLandingPasses').size).toBe(0),
        { timeout: 5_000 },
      );
      expect(prompt).not.toHaveBeenCalled();
      expect(activityStages(fixture.published)).toContain('landed');
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('still recovers a missed WS event through the maintenance approval pass', async () => {
    const fixture = await readyCorner();
    try {
      fixture.approvals.push(fixture.approval);

      await Reflect.get(fixture.body, 'runApprovalLandingPass').call(fixture.body, 'room-ack');

      expect(fixture.info.landedTip).toBe(fixture.tip);
      expect(activityStages(fixture.published)).toContain('approval-received');
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});
