/**
 * Live security suite — the two spec-mandated "write these first" tests
 * (`spec.md` → Failure modes → Agent in push-rights):
 *
 *   1. Unauthorized push to the protected branch is REJECTED BY THE RELAY,
 *      and `main`'s tip is byte-identical before/after (ls-remote). Assert on
 *      state, not the ack.
 *   2. Provisioning check: agent is never in push-allowed on a correctly
 *      provisioned repo; the same check FAILS when the agent is mis-granted
 *      admin.
 *
 * Requires the real Buzz relay stack (`npm run stack:up` from repo root;
 * local harness at http://127.0.0.1:3010). Run with `npm run test:live` from apps/gate.
 * If the relay is unreachable the suite exits 0 with a clear skip message;
 * it NEVER auto-skips when the relay is reachable.
 *
 * Each test provisions its own uniquely-named channel+repo — no shared
 * fixtures with scripts/money-shot.ts.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeAll } from 'vitest';
import { newIdentity, type Identity } from './identity.js';
import { createChannel, setMemberRole, announceRepo } from './buzz.js';
import { git, gitAuthed, lsRemoteRef } from './git.js';
import { gitRepoUrl, BASE_URL, HOST } from './config.js';
import { checkAgentNotPushAllowed } from './provisioning.js';
import { createRelayClient } from './relay.js';

const RELAY_PROBE_MS = 2500;

async function relayReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE_URL}/health`, {
      headers: { host: HOST },
      signal: AbortSignal.timeout(RELAY_PROBE_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function commit(dir: string, file: string, content: string, msg: string): Promise<void> {
  writeFileSync(join(dir, file), content);
  const add = await git(dir, ['add', '-A']);
  if (!add.ok) throw new Error(`git add failed: ${add.stderr}`);
  const c = await git(dir, ['commit', '-m', msg]);
  if (!c.ok) throw new Error(`git commit failed: ${c.stderr}`);
}

async function waitRepoCloneable(
  identity: Identity,
  ownerHex: string,
  repo: string,
): Promise<void> {
  const url = gitRepoUrl(ownerHex, repo);
  for (let i = 0; i < 20; i++) {
    const r = await gitAuthed(tmpdir(), identity, ownerHex, repo, ['ls-remote', url]);
    if (r.ok) return;
    await sleep(500);
  }
  throw new Error(`repo ${ownerHex}/${repo} never became cloneable`);
}

/** Unique short id so parallel live runs never collide. */
function uniqueRepoName(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

interface Provisioned {
  worker: Identity;
  agent: Identity;
  owner: string;
  repo: string;
  channelId: string;
  url: string;
  seedDir: string;
  baseMain: string;
}

/**
 * Provision a fresh channel+repo with the standard Buzzy ACL:
 * worker=owner, agent=member (or admin if misprovisioned), main push:admin.
 * Seeds `main` with an initial commit.
 */
async function provisionFresh(opts: {
  prefix: string;
  agentRole: 'member' | 'admin';
}): Promise<Provisioned> {
  const worker = newIdentity('worker');
  const agent = newIdentity('agent');
  const owner = worker.publicKey;
  const repo = uniqueRepoName(opts.prefix);
  const url = gitRepoUrl(owner, repo);

  const channelId = await createChannel(worker, repo);
  await setMemberRole(worker, channelId, agent.publicKey, opts.agentRole);
  await announceRepo(worker, repo, channelId);
  await waitRepoCloneable(worker, owner, repo);

  const seedDir = mkdtempSync(join(tmpdir(), 'buzzy-live-seed-'));
  await git(seedDir, ['init', '-q', '-b', 'main']);
  await commit(seedDir, 'README.md', `# ${repo}\n`, 'initial commit');
  const seedPush = await gitAuthed(seedDir, worker, owner, repo, ['push', url, 'main']);
  if (!seedPush.ok) {
    throw new Error(`owner seed push failed: ${seedPush.stderr}`);
  }
  const baseMain = await lsRemoteRef(seedDir, worker, owner, repo, 'refs/heads/main');
  if (!baseMain || !/^[0-9a-f]{40}$/.test(baseMain)) {
    throw new Error(`could not resolve seeded main tip: ${baseMain}`);
  }

  return { worker, agent, owner, repo, channelId, url, seedDir, baseMain };
}

const reachable = await relayReachable();

(reachable ? describe : describe.skip)('live push-rights security suite', () => {
  beforeAll(() => {
    console.log(`[live] relay reachable at ${BASE_URL} — running suite`);
  });

  it('agent may push a feature branch (proves membership is real, not vacuous)', async () => {
    const p = await provisionFresh({ prefix: 'live-feat', agentRole: 'member' });

    const agentRoot = mkdtempSync(join(tmpdir(), 'buzzy-live-agent-'));
    const cloneRes = await gitAuthed(agentRoot, p.agent, p.owner, p.repo, ['clone', p.url, 'work']);
    expect(cloneRes.ok, cloneRes.stderr).toBe(true);

    const work = join(agentRoot, 'work');
    const branch = 'feature/live-change';
    await git(work, ['checkout', '-q', '-b', branch]);
    await commit(work, 'CHANGE.txt', 'agent feature change\n', 'agent: feature change');

    const pushFeature = await gitAuthed(work, p.agent, p.owner, p.repo, ['push', 'origin', branch]);
    expect(
      pushFeature.ok && !/rejected|denied|forbidden/i.test(pushFeature.stderr),
      `feature push should be allowed: ${pushFeature.stderr}`,
    ).toBe(true);

    const remoteFeature = await lsRemoteRef(work, p.agent, p.owner, p.repo, `refs/heads/${branch}`);
    const localTip = (await git(work, ['rev-parse', 'HEAD'])).stdout.trim();
    expect(remoteFeature).toBe(localTip);
  }, 60_000);

  it('agent push to protected main is rejected by the relay AND main tip is unchanged', async () => {
    const p = await provisionFresh({ prefix: 'live-main', agentRole: 'member' });

    const agentRoot = mkdtempSync(join(tmpdir(), 'buzzy-live-agent-'));
    const cloneRes = await gitAuthed(agentRoot, p.agent, p.owner, p.repo, ['clone', p.url, 'work']);
    expect(cloneRes.ok, cloneRes.stderr).toBe(true);
    const work = join(agentRoot, 'work');

    // Build a commit the agent will try to force onto main.
    const branch = 'feature/evil-main';
    await git(work, ['checkout', '-q', '-b', branch]);
    await commit(work, 'EVIL.txt', 'should never land on main\n', 'agent: evil main push');

    const mainBefore = await lsRemoteRef(p.seedDir, p.worker, p.owner, p.repo, 'refs/heads/main');
    expect(mainBefore).toBe(p.baseMain);

    // THE critical assertion: relay refuses the push.
    const pushMain = await gitAuthed(work, p.agent, p.owner, p.repo, [
      'push',
      'origin',
      'HEAD:main',
    ]);
    const relayRejected =
      !pushMain.ok ||
      /rejected|denied|forbidden|push:admin|admin role|not allowed|permission/i.test(
        pushMain.stderr + pushMain.stdout,
      );
    expect(
      relayRejected,
      `expected relay rejection, got ok=${pushMain.ok} stderr=${pushMain.stderr} stdout=${pushMain.stdout}`,
    ).toBe(true);
    // Always log the remote error so the PR transcript shows the real refusal.
    console.log(
      '[live] relay refusal stderr:',
      pushMain.stderr.trim().split('\n').slice(-4).join(' | '),
    );

    // Assert on state, not the ack (spec gotcha): main tip must be byte-identical.
    const mainAfter = await lsRemoteRef(p.seedDir, p.worker, p.owner, p.repo, 'refs/heads/main');
    expect(mainAfter).toBe(mainBefore);
    expect(mainAfter).toBe(p.baseMain);
  }, 60_000);

  it('provisioning check PASSES on a correctly provisioned repo (agent=member)', async () => {
    const p = await provisionFresh({ prefix: 'live-prov-ok', agentRole: 'member' });

    // Give the relay a beat to index membership + announcement for /query.
    await sleep(300);

    const result = await checkAgentNotPushAllowed({
      ownerHex: p.owner,
      repo: p.repo,
      agentPubkey: p.agent.publicKey,
      relay: createRelayClient(p.agent),
    });
    expect(result.ok, result.reason).toBe(true);
    expect(result.agentCanPushProtected).toBe(false);
    expect(result.agentRole).toBe('member');
    expect(result.protection?.pushMinRole).toBe('admin');
    expect(result.channelId).toBe(p.channelId);
  }, 60_000);

  it('provisioning check FAILS when the agent is mis-granted admin (catch misconfig)', async () => {
    const p = await provisionFresh({ prefix: 'live-prov-bad', agentRole: 'admin' });
    await sleep(300);

    const result = await checkAgentNotPushAllowed({
      ownerHex: p.owner,
      repo: p.repo,
      agentPubkey: p.agent.publicKey,
      relay: createRelayClient(p.agent),
    });
    expect(result.ok, `expected FAIL on misprovisioned admin agent, got: ${result.reason}`).toBe(
      false,
    );
    expect(result.agentCanPushProtected).toBe(true);
    expect(result.agentRole).toBe('admin');
    expect(result.reason).toMatch(/push-allowed|meets push:admin|role=admin/i);
  }, 60_000);
});
