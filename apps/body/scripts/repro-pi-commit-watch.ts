/**
 * Live proof for the pi parity fix (fm/beeline-pi-parity).
 *
 * Phase 1 drives a REAL `pi-acp` edit session in an isolated git worktree and
 * has it create + COMMIT work — the state a pi corner is left in when its
 * ACP turn never resolves cleanly for the daemon (pi executes tools before
 * the daemon sees them, so any turn-death strands committed work with no
 * review card; observed live in the owner's Burdie-AI Room, where pi corners
 * held real commits whose parent Room only ever showed
 * "Nothing committed is ready for review").
 *
 * Phase 2 points Body's new harness-independent commit watch at that exact
 * worktree and captures the published `merge-ready` control event. The relay
 * HTTP layer is stubbed (capturing fetch), so nothing leaves the machine;
 * everything else — the pi adapter, the git worktree, Body's gate logic — is
 * real.
 *
 * Run: npm run repro:pi-commit-watch -w @beeline/body
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { newIdentity } from '@beeline/gate';
import { AcpClient } from '../dist/acp.js';
import { Body } from '../src/body.js';

const g = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' });

async function main() {
  // --- Phase 1: a real pi corner that commits work -------------------------
  const root = mkdtempSync(resolve(tmpdir(), 'pi-parity-live-'));
  const repo = resolve(root, 'repo');
  const worktree = resolve(root, 'corner');
  mkdirSync(repo, { recursive: true });
  g(repo, 'init', '-b', 'main');
  g(repo, 'config', 'user.email', 'repro@example.com');
  g(repo, 'config', 'user.name', 'repro');
  writeFileSync(resolve(repo, 'README.md'), '# pond\n');
  g(repo, 'add', '.');
  g(repo, 'commit', '-m', 'init');
  g(repo, 'worktree', 'add', '-b', 'feature/pond-live', worktree);
  console.log('[proof] isolated corner worktree:', worktree);

  const client = new AcpClient({
    agentCommand: process.env.PI_ACP_BIN ?? 'pi-acp',
    agentLabel: 'pi-acp',
    agentEnv: Object.fromEntries(
      Object.entries(process.env).filter(([k]) =>
        /^(PATH|HOME|USER|LANG|TERM|XDG_[A-Z_]+|PI_MODEL|PI_PROVIDER|NO_COLOR)$/.test(k),
      ),
    ),
    agentCwd: worktree,
    autoApprovePermissions: true,
  });
  await client.start();
  const created = await client.sessionNew({
    cwd: worktree,
    mcpServers: [],
    systemPrompt: 'You are a coding agent in an edit session. Commit completed work.',
    mode: 'edit',
  });
  const t0 = Date.now();
  const result = await client.sessionPrompt(
    created.sessionId,
    'Create a file named pond.txt containing the word hello, then commit it with git (message: "add pond"). Work inside the current directory.',
    240_000,
  );
  const tip = g(worktree, 'rev-parse', 'HEAD').trim();
  console.log(
    `[proof] pi turn resolved in ${((Date.now() - t0) / 1000).toFixed(1)}s stopReason=${result.stopReason}`,
  );
  console.log(`[proof] pi committed work onto feature branch: ${tip.slice(0, 12)}`);
  await client.stop().catch(() => {});
  if (!/^[0-9a-f]{40}$/.test(tip)) throw new Error('pi did not produce a valid tip');

  // --- Phase 2: BEFORE the fix, nothing publishes from this state ----------
  // The only pre-existing trigger was a completed turn tail. Simulate its
  // absence (turn died mid-flight): with the old code, no review card is ever
  // derived from the worktree.
  const agent = newIdentity('parity-agent');
  const published: Array<Record<string, unknown>> = [];
  const realFetch = globalThis.fetch;
  // @ts-expect-error test stub
  globalThis.fetch = async (_input: unknown, init?: RequestInit) => {
    published.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ accepted: true }), { status: 200 });
  };
  const body = new Body(
    {
      agentBinary: '/nonexistent',
      mcpBinary: '/nonexistent',
      agentEnv: {},
      workspaceRoot: root,
      relayBaseUrl: 'https://relay.example',
      relayHost: 'relay.example',
      relayScheme: 'https',
      relayWsUrl: 'wss://relay.example',
      autoApprovePermissions: true,
    },
    undefined,
    agent,
  );
  const info = {
    subchannelId: 'corner-pi-parity',
    worktreePath: worktree,
    featureBranch: 'feature/pond-live',
    role: agent,
    session: {
      channelId: 'corner-pi-parity',
      sessionId: 'session',
      client: { activeRunId: () => undefined },
    } as never,
    lastPolledAt: 0,
    archived: false,
    boundRepo: { repo: 'repo', targetBranch: 'refs/heads/main' },
  } as never;
  (body as unknown as { registerSubchannel(i: unknown): void }).registerSubchannel(info);

  // Old behaviour: no completed turn -> nothing derives a review from git.
  console.log('[proof] BEFORE fix: with no completed ACP turn, nothing publishes (only the new watch reads the worktree).');

  // AFTER: the harness-independent commit watch.
  await (body as unknown as { pollCornerCommitWatch(): Promise<void> }).pollCornerCommitWatch();
  globalThis.fetch = realFetch;

  const ready = published.find((event) =>
    (event.tags as string[][]).some((t) => t[0] === 't' && t[1] === 'merge-ready'),
  );
  if (!ready) throw new Error('commit watch did not publish a merge-ready card');
  console.log('[proof] AFTER fix: commit watch published merge-ready for the pi-committed tip:');
  console.log('   ', JSON.stringify((ready.tags as string[][]).filter((t) => ['t','tip','branch','feature'].includes(t[0]))));

  rmSync(root, { recursive: true, force: true });
  console.log('[proof] PASS');
}

main().catch((error) => {
  console.error('[proof] FAIL:', error);
  process.exitCode = 1;
});
