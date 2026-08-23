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
 *   - an authority-verified approval naming a STALE tip is rejected once,
 *     with the plain reason (which old tip, which current tip) and no git
 *     plumbing;
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
import { APPROVAL_ACK_TAG } from './body.js';

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
): NostrEvent {
  // The canonical builder (same wire shape mobile signs), so the daemon's own
  // `verifyApproval` accepts it exactly as it does in production.
  return gateBuildApproval(reviewer, 'corner-ack', {
    repo: 'local/local-key',
    branch: 'refs/heads/master',
    tip,
  });
}

/** Relay stub answering approval scans, admin projections (reviewer is a human
 *  admin), and agent-registry lookups (the reviewer is NOT an agent). */
function stubAgentRelay(approvals: NostrEvent[], adminPubkeys: string[]) {
  const adminProjection = signEvent(
    {
      pubkey: adminPubkeys[0] ?? 'a'.repeat(64),
      created_at: Math.floor(Date.now() / 1000),
      kind: KIND_CHANNEL_ADMINS,
      tags: [
        ['d', 'corner-ack'],
        ...adminPubkeys.map((pubkey) => ['p', pubkey, 'admin']),
      ],
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
      // Agent-identity registry lookup for the reviewer: empty → human.
      return [];
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
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a stale-tip approval immediately, plainly, and only once', async () => {
    const agent = newIdentity('ack-agent-stale');
    const reviewer = newIdentity('ack-reviewer-stale');
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
      const staleTip = 'a'.repeat(40);
      const stale = buildApproval(reviewer, staleTip);
      Reflect.set(body, 'agentRelay', stubAgentRelay([stale], [reviewer.publicKey]));

      const find = Reflect.get(body, 'findHumanMergeApproval').bind(body);
      const found = await find(info);
      expect(found).toBeUndefined();
      await find(info);

      const rejections = published.filter((event) =>
        event.tags.some((tag) => tag[0] === 't' && tag[1] === APPROVAL_ACK_TAG),
      );
      expect(rejections.length).toBe(1);
      const rejection = rejections[0]!;
      expect(rejection.tags).toContainEqual(['decision', 'rejected']);
      expect(rejection.tags).toContainEqual(['rejected-tip', staleTip]);
      expect(rejection.content).toContain(staleTip.slice(0, 12));
      expect(rejection.content).toContain(tip.slice(0, 12));
      expect(rejection.content.toLowerCase()).not.toMatch(/\bgit\b|non-fast-forward|hint:/);
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
});
