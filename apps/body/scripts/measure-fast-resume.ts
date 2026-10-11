/**
 * Isolated helper startup replay. No account, token, provider or live helper.
 * Run: node --import tsx apps/body/scripts/measure-fast-resume.ts [--baseline=<git-ref>]
 *
 * Journal evidence, 2026-10-11 17:13:45–17:16:20 EDT: twenty agents,
 * 178 Room bindings, 602 denied archived-worktree reads (56 distinct corners),
 * 337 unpublished worktree recoveries (39 distinct corners), and scratch
 * sweeps up to 478 roots. Operator-skill activation skipped 54 nonordinary
 * files, 6 missing files and 45 linked directories. The main barrier was
 * sweepArchivedCornerWorktrees, ahead of startRoom in reconcile.
 *
 * Replays those operations with real Git/worktree recovery, scratch sweeps,
 * home provisioning and the production six-slot/50ms HostReadBudget. Only
 * the remote API (20ms local response) and provider answer are fixtures.
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { ThinDaemonCore } from '../src/thin-core.js';
import { MonolithRoomTurnLoop } from '../src/monolith-room-turn.js';
import { cornerRepositoryCacheDir } from '../src/room-runtime.js';
import { HostReadBudget } from '../src/host-read-budget.js';
import { prepareRoomAgentHome, roomSessionTmpDir } from '../src/agent-home.js';
import { runScratchSweep } from '../src/scratch-sweep.js';
import { DaemonApiError, type DaemonApiClient } from '../src/daemon-api-client.js';
import { identityFromKey, type AgentRuntimeRecord } from '../src/runtime.js';
import type { AgentCommand } from '@beeline/api-contract/daemon';

const exec = promisify(execFile);
const repository = resolve(import.meta.dirname, '../../..');
const baseline = process.argv.find(arg => arg.startsWith('--baseline='))?.slice('--baseline='.length);
const root = await mkdtemp(resolve(repository, '.fast-resume-replay-'));
process.env.XDG_STATE_HOME = root;
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test',
  GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' };
const git = async (...args: string[]) => (await exec('git', args, { env: gitEnv })).stdout.trim();
const stats = { denied: 0, recovered: 0, scratchRoots: 0, skippedSkills: 0, roomBindings: 0, reads: 0, retries401: 0 };
const output = console.log.bind(console);
const originalError = console.error;
console.log = (...args) => {
  const text = String(args[0]);
  if (text.includes('serving monolith Room')) stats.roomBindings++;
  const roots = text.match(/under (\d+) roots/);
  if (roots) stats.scratchRoots += Number(roots[1]);
};
console.warn = (...args) => {
  const text = String(args[0]);
  if (text.includes('recoverable at')) stats.recovered++;
  if (text.includes('skipping operator skill')) stats.skippedSkills++;
};
console.error = (...args) => {
  if (String(args[0]).includes('cleanup deferred')) return;
  if (String(args[0]).includes('discovery failed')) return;
  originalError(...args);
};
const controllers: AbortController[] = [];
const running: Promise<unknown>[] = [];
const starts: (() => Promise<unknown>)[] = [];
const shortTmpLinks = new Set<string>();
let startedAt = 0;
let firstClaimMs: number | undefined;
let answerMs: number | undefined;
let resolveAnswer!: () => void;
const answer = new Promise<void>(done => { resolveAnswer = done; });
const originalStart = Reflect.get(MonolithRoomTurnLoop.prototype, 'startPrompt');
try {
  let Core = ThinDaemonCore;
  if (baseline) {
    await writeFile(resolve(root, 'package.json'), '{"type":"module"}');
    const sourceRoot = resolve(repository, 'apps/body/src');
    const baselineRoom = resolve(root, 'room-runtime.ts');
    for (const name of ['room-runtime', 'thin-core']) {
      let source = await git('show', `${baseline}:apps/body/src/${name}.ts`);
      source = source.replace(/from '\.\/([^']+)'/g, (_whole, module: string) =>
        `from '${pathToFileURL(name === 'thin-core' && module === 'room-runtime.js' ? baselineRoom : resolve(sourceRoot, module)).href}'`);
      await writeFile(resolve(root, `${name}.ts`), source);
    }
    Core = (await import(pathToFileURL(resolve(root, 'thin-core.ts')).href)).ThinDaemonCore;
  }
  const seed = resolve(root, 'seed');
  await git('init', '-b', 'main', seed);
  await writeFile(resolve(seed, 'README.md'), 'Isolated replay\n');
  await git('-C', seed, 'add', 'README.md');
  await git('-C', seed, 'commit', '-m', 'fixture');
  const remote = resolve(root, 'remote.git');
  await git('clone', '--bare', seed, remote);
  const remoteUrl = pathToFileURL(remote).href;
  // Two state roots, ten agents apiece, match the journal's overlapping scans.
  for (let group = 0; group < 2; group++) {
    const state = resolve(root, `group-${group}`);
    const common = cornerRepositoryCacheDir(state, remoteUrl);
    await mkdir(dirname(common), { recursive: true });
    await git('clone', '--bare', remote, common);
    await git(`--git-dir=${common}`, 'fetch', 'origin', '+refs/heads/main:refs/remotes/origin/main');
    await git(`--git-dir=${common}`, 'config', 'extensions.worktreeConfig', 'true');
    for (let i = 0; i < 48; i++) {
      const corner = `archived-${String(i).padStart(3, '0')}`;
      const path = resolve(state, 'beeline/corners', corner);
      await mkdir(dirname(path), { recursive: true });
      await git(`--git-dir=${common}`, 'worktree', 'add', '-b', `feature/${corner}`, path, 'main');
      await git('-C', path, 'config', '--worktree', 'core.bare', 'false');
      // Twenty retain unpublished work; the remaining twenty-eight are inaccessible.
      if (i < 20) await writeFile(resolve(path, 'unpublished.txt'), 'Never remove this local work\n');
    }
  }
  const operator = resolve(root, 'operator');
  const skills = resolve(operator, '.codex/skills');
  await mkdir(skills, { recursive: true });
  await writeFile(resolve(operator, 'skill-reference.md'), '# Reference\n');
  for (let i = 0; i < 105; i++) {
    const dir = resolve(skills, `skill-${i}`);
    if (i >= 60) await symlink(seed, dir, 'dir');
    else {
      await mkdir(dir);
      if (i < 54) await symlink(resolve(operator, 'skill-reference.md'), resolve(dir, 'SKILL.md'));
    }
  }
  const agents = Array.from({ length: 20 }, (_, i) => identityFromKey((i + 1).toString(16).padStart(64, '0'), `Fixture ${i}`));
  const origin = 'http://127.0.0.1:1'; // No request is sent; budget identity only.
  const budget = new HostReadBudget(origin, root);
  Reflect.set(MonolithRoomTurnLoop.prototype, 'startPrompt', function(this: {
    options: { config: { agentHomeRoot: string }; roomId: string }; busy: boolean; activeTurn?: { promise: Promise<void> };
  }) {
    const home = this.options.config.agentHomeRoot;
    shortTmpLinks.add(roomSessionTmpDir(home));
    const promise = prepareRoomAgentHome({ root: home, operatorHome: operator, agentKind: 'codex', skillReleaseId: 'fixture' })
      .then(() => { answerMs = performance.now() - startedAt; resolveAnswer(); })
      .finally(() => { this.busy = false; this.activeTurn = undefined; });
    this.activeTurn = { promise };
  });
  for (let i = 0; i < agents.length; i++) {
    const state = resolve(root, `group-${i % 2}`);
    const runtimeDir = resolve(state, `agent-${i}`);
    // 478 startup scratch roots across the helper, including old per-Room homes.
    for (let j = 0; j < (i === 0 ? 98 : 20); j++) {
      await mkdir(resolve(runtimeDir, 'rooms', `old-home-${j}`, 'agent-home', 'tmp'), { recursive: true });
      await writeFile(resolve(runtimeDir, 'rooms', `old-home-${j}`, 'agent-home/tmp/scratch.txt'), 'fixture');
    }
    const agent = agents[i]!;
    const rooms = Array.from({ length: i < 18 ? 9 : 8 }, (_, j) => ({ roomId: `room-${i}-${j}`, archived: false }));
    const target = rooms.at(-1)!.roomId;
    const pending: AgentCommand = {
      id: 'pending', roomId: target, agentId: agent.publicKey, sourceMessageId: 'human', turnRequestId: 'human',
      action: 'input', reason: 'human_tag', rootCommandId: 'pending', rootSourceMessageId: 'human', agentDepth: 0,
      source: { id: 'human', authorId: 'fixture-person', body: 'Are you back?', createdAt: 1, type: 'message', attachments: [] },
    };
    let bootstrapCalls = 0;
    const execute = async (name: string, input: { roomId?: string; cornerId?: string }) => {
      if (controllers.some(abort => abort.signal.aborted)) throw new Error('fixture stopped');
      const read = /^(get|list)/.test(name);
      const urgent = name === 'getAgentCommands' || (!baseline && name === 'getDaemonBootstrap');
      const release = read ? await budget.acquire(urgent ? 'urgent' : 'background', Date.now() + 30_000) : undefined;
      try {
        if (read) { stats.reads++; await new Promise(done => setTimeout(done, 20)); }
        if (name === 'getDaemonBootstrap') {
          if (i === 19 && ++bootstrapCalls <= 2) { stats.retries401++; throw new DaemonApiError('fixture token retry', 401, false); }
          return { workspaceIds: ['fixture-workspace'], rooms, pendingRooms: i === 0 ? [{ roomId: target }] : [] };
        }
        if (name === 'listRoomCorners') return { corners: [] };
        if (name === 'getCornerRestoreState') {
          if (Number(input.cornerId!.split('-').at(-1)) >= 20) {
            stats.denied++; throw new DaemonApiError('fixture access denied', 403, false);
          }
          return { archived: true, parentRoomId: rooms[0]!.roomId, featureBranch: `feature/${input.cornerId}`, lifecycle: {} };
        }
        if (name === 'getRoomRepositoryState') return { resolution: 'repository', key: 'fixture', remote: remoteUrl, targetBranch: 'main' };
        if (name === 'getRoomGitHubToken') return { token: 'fixture-unused' };
        if (name === 'getAgentCommands') return { commandProtocol: 1,
          commands: i === 0 && input.roomId === target && firstClaimMs === undefined ? [pending] : [] };
        if (name === 'claimAgentCommand') { firstClaimMs = performance.now() - startedAt; return { id: 'claimed' }; }
        throw new Error(`unexpected fixture operation ${name}`);
      } finally { await release?.(); }
    };
    const core = new Core({
      agent: { publicKey: agent.publicKey, secretKeyHex: (i + 1).toString(16).padStart(64, '0'), name: `Fixture ${i}` },
      rooms: [], communityId: 'fixture-workspace', supervisorRoot: state,
      transport: { kind: 'monolith', baseUrl: origin, daemonToken: 'fixture-unused' },
    } as unknown as AgentRuntimeRecord, resolve(runtimeDir, 'agent.json'), { workspaceRoot: runtimeDir, operatorHome: operator } as never, {
      daemonApi: { execute, liveSubscribe: () => () => undefined } as unknown as DaemonApiClient,
    });
    const abort = new AbortController();
    controllers.push(abort);
    // Setup is complete for all twenty before any coordinator starts.
    starts.push(async () => {
      await runScratchSweep(runtimeDir, process.env);
      return core.run({ signal: abort.signal });
    });
  }
  startedAt = performance.now();
  running.push(...starts.map(start => start()));
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Replay timed out')), 360_000); });
  try {
    await Promise.race([answer, timeout]);
    output(JSON.stringify({ mode: baseline ? 'before' : 'after', agents: 20, rooms: 178, worktrees: 96,
      firstClaimMs: Math.round(firstClaimMs!), answerMs: Math.round(answerMs!), atAnswer: { ...stats }, budget: budget.metrics() }));
    if (!baseline && firstClaimMs! > 5_000) throw new Error('First claim exceeded five seconds');
  } finally {
    clearTimeout(timer);
    for (const abort of controllers) abort.abort();
    await Promise.allSettled(running);
  }
} finally {
  Reflect.set(MonolithRoomTurnLoop.prototype, 'startPrompt', originalStart);
  for (const link of shortTmpLinks) await rm(link, { force: true });
  await rm(root, { recursive: true, force: true });
}
