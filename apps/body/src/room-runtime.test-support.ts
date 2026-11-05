
import { execFile as m16_execFile } from 'node:child_process';


import { access as m16_access, mkdtemp as m16_mkdtemp, rm as m16_rm, writeFile as m16_writeFile } from 'node:fs/promises';


import { tmpdir as m16_tmpdir } from 'node:os';


import { resolve as m16_resolve } from 'node:path';


import { promisify as m16_promisify } from 'node:util';


import { afterEach as m16_afterEach, describe as m16_describe, expect as m16_expect, it as m16_it } from 'vitest';


import {
  cornerBranchIsSafeToDelete as m16_cornerBranchIsSafeToDelete,
  materializeCornerWorktree as m16_materializeCornerWorktree,
  removeCornerWorktreeAndBranches as m16_removeCornerWorktreeAndBranches,
} from "./room-runtime.js";

import { describe as mergedDescribe16 } from 'vitest';


import { execFile as m35_execFile } from 'node:child_process';


import { access as m35_access, mkdir as m35_mkdir, mkdtemp as m35_mkdtemp, rm as m35_rm, writeFile as m35_writeFile } from 'node:fs/promises';


import { tmpdir as m35_tmpdir } from 'node:os';


import { resolve as m35_resolve } from 'node:path';


import { promisify as m35_promisify } from 'node:util';


import { expect as m35_expect, it as m35_it, vi as m35_vi } from 'vitest';


import type { DaemonApiClient as m35_DaemonApiClient } from "./daemon-api-client.js";


import { RoomRuntimeCoordinator as m35_RoomRuntimeCoordinator, materializeCornerWorktree as m35_materializeCornerWorktree } from "./room-runtime.js";


import { MonolithCornerTurnLoop as m35_MonolithCornerTurnLoop } from "./monolith-corner-turn.js";


import { agentCornerCheckoutPaths as m35_agentCornerCheckoutPaths } from "./agent-corner-checkout.js";


import { readStorageOwners as m35_readStorageOwners, rememberStorageOwner as m35_rememberStorageOwner, markAgentStorageEnded as m35_markAgentStorageEnded, pruneEndedOwnerStorage as m35_pruneEndedOwnerStorage } from "./storage-owners.js";


import { identityFromKey as m35_identityFromKey, type AgentRuntimeRecord as m35_AgentRuntimeRecord } from "./runtime.js";

import { describe as mergedDescribe35 } from 'vitest';


import { mkdtemp as m36_mkdtemp, rm as m36_rm } from 'node:fs/promises';


import { tmpdir as m36_tmpdir } from 'node:os';


import { join as m36_join } from 'node:path';


import { afterEach as m36_afterEach, describe as m36_describe, expect as m36_expect, it as m36_it, vi as m36_vi } from 'vitest';


import type { DaemonApiClient as m36_DaemonApiClient } from "./daemon-api-client.js";


import { identityFromKey as m36_identityFromKey, type AgentRuntimeRecord as m36_AgentRuntimeRecord } from "./runtime.js";


import { RoomRuntimeCoordinator as m36_RoomRuntimeCoordinator } from "./room-runtime.js";

import { describe as mergedDescribe36 } from 'vitest';


import { mkdtemp as m37_mkdtemp, rm as m37_rm } from 'node:fs/promises';


import { tmpdir as m37_tmpdir } from 'node:os';


import { resolve as m37_resolve } from 'node:path';


import { afterEach as m37_afterEach, describe as m37_describe, expect as m37_expect, it as m37_it, vi as m37_vi } from 'vitest';


import { DaemonApiError as m37_DaemonApiError } from "./daemon-api-client.js";


import type { DaemonApiClient as m37_DaemonApiClient } from "./daemon-api-client.js";


import { RoomRuntimeCoordinator as m37_RoomRuntimeCoordinator } from "./room-runtime.js";


import { identityFromKey as m37_identityFromKey, type AgentRuntimeRecord as m37_AgentRuntimeRecord } from "./runtime.js";

import { describe as mergedDescribe37 } from 'vitest';


import { mkdtemp as m38_mkdtemp, rm as m38_rm } from 'node:fs/promises';


import { tmpdir as m38_tmpdir } from 'node:os';


import { resolve as m38_resolve } from 'node:path';


import { expect as m38_expect, it as m38_it, vi as m38_vi } from 'vitest';


import { RoomRuntimeCoordinator as m38_RoomRuntimeCoordinator, type CornerWorktree as m38_CornerWorktree } from "./room-runtime.js";


import { identityFromKey as m38_identityFromKey, type AgentRuntimeRecord as m38_AgentRuntimeRecord } from "./runtime.js";

import { describe as mergedDescribe38 } from 'vitest';


import { execFile as move2_execFile } from 'node:child_process';


import { mkdtemp as move2_mkdtemp, rm as move2_rm, writeFile as move2_writeFile } from 'node:fs/promises';


import { tmpdir as move2_tmpdir } from 'node:os';


import { resolve as move2_resolve } from 'node:path';


import { promisify as move2_promisify } from 'node:util';


import { afterEach as move2_afterEach, describe as move2_describe, expect as move2_expect, it as move2_it } from 'vitest';


import { materializeCornerWorktree as move2_materializeCornerWorktree } from "./room-runtime.js";

import { describe as movedDescribe2 } from 'vitest';

export function fixtureScope1() {



/**
 * A corner's branch is the shared artifact its pull request points at. Close
 * cleanup may take the worktree, but never an open pull request's head branch:
 * deleting that closes the pull request and leaves the commits reachable only
 * through `refs/pull/<n>/head`. These run against a real bare repository so the
 * proof is git's own answer, not a mock that agrees with the code.
 */
const execFileAsync = m16_promisify(m16_execFile);


const roots: string[] = [];


m16_afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => m16_rm(root, { recursive: true, force: true }))),
);



const FEATURE = 'feature/corner-open-pr';



const COMMITTER = {
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};



async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync('git', ['-C', cwd, ...args], {
    env: { ...process.env, ...COMMITTER },
  });
  return result.stdout.trim();
}



/** A bare repository with `main` and a corner branch one commit ahead of it. */
async function remoteWithCornerBranch(): Promise<{ remote: string }> {
  const scratch = await m16_mkdtemp(m16_resolve(m16_tmpdir(), 'beeline-corner-preserve-remote-'));
  roots.push(scratch);
  const seed = m16_resolve(scratch, 'seed');
  await execFileAsync('git', ['init', '-b', 'main', seed]);
  await m16_writeFile(m16_resolve(seed, 'README.md'), 'objective\n');
  await git(seed, 'add', '.');
  await git(seed, 'commit', '-m', 'objective');
  await git(seed, 'checkout', '-b', FEATURE);
  await m16_writeFile(m16_resolve(seed, 'opener.txt'), 'work the opener pushed\n');
  await git(seed, 'add', '.');
  await git(seed, 'commit', '-m', 'opener work');
  await git(seed, 'checkout', 'main');
  const bare = m16_resolve(scratch, 'remote.git');
  await execFileAsync('git', ['clone', '--bare', seed, bare]);
  return { remote: `file://${bare}` };
}
return {
execFileAsync,
roots,
FEATURE,
COMMITTER,
git,
remoteWithCornerBranch,
};
}
export function fixtureScope4() {



const exec = m35_promisify(m35_execFile);



async function cornerFixture(prefix: string, implementerAgentId: (self: string) => string) {
  const root = await m35_mkdtemp(m35_resolve(m35_tmpdir(), prefix));
  const identity = m35_identityFromKey('11'.repeat(32), 'Bee');
  const runtime = { agent: { name: 'Bee', publicKey: identity.publicKey, secretKeyHex: '11'.repeat(32) },
    rooms: [], communityId: 'workspace', supervisorRoot: root,
    transport: { kind: 'monolith', baseUrl: 'https://server.example', daemonToken: 'fixture' } } as m35_AgentRuntimeRecord;
  const remote = m35_resolve(root, 'remote.git'), roomCheckout = m35_resolve(root, 'room');
  const posted: string[] = [];
  const execute = m35_vi.fn(async (name: string, input: { text?: string }) => {
    if (name === 'getCornerRestoreState') return { cornerId: 'corner', objective: 'Fix it', closeRequested: false,
      implementerAgentId: implementerAgentId(identity.publicKey), brief: { repositoryWork: true } };
    if (name === 'getRoomRepositoryState') return { resolution: 'repository', key: 'owner/repo', remote: `file://${remote}` };
    if (name === 'getRoomGitHubToken') return { token: 'fixture', expiresAt: Date.now() + 60_000 };
    if (name === 'postRoomMessage') posted.push(input.text!);
    return {};
  });
  const coordinator = new m35_RoomRuntimeCoordinator(runtime, m35_resolve(root, 'runtime.json'), { workspaceRoot: root } as never,
    { daemonApi: { execute } as unknown as m35_DaemonApiClient });
  let loop!: m35_MonolithCornerTurnLoop;
  const run = m35_vi.spyOn(m35_MonolithCornerTurnLoop.prototype, 'run').mockImplementation(function (this: m35_MonolithCornerTurnLoop) {
    loop = this;
    const signal = (this as unknown as { options: { signal: AbortSignal } }).options.signal;
    return new Promise<void>(done => signal.addEventListener('abort', () => done(), { once: true }));
  });
  const internal = coordinator as unknown as { startCorner(input: { cornerId: string; parentRoomId: string }): Promise<void>;
    materializeRoomCheckout(): Promise<string>; grantRunnerEndpoint(): Promise<undefined> };
  m35_vi.spyOn(internal, 'materializeRoomCheckout').mockResolvedValue(roomCheckout);
  m35_vi.spyOn(internal, 'grantRunnerEndpoint').mockResolvedValue(undefined);
  await exec('git', ['init', '-b', 'main', roomCheckout]);
  await m35_writeFile(m35_resolve(roomCheckout, 'file'), 'source');
  await exec('git', ['-C', roomCheckout, 'add', '.']);
  await exec('git', ['-C', roomCheckout, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'base']);
  await exec('git', ['clone', '--bare', roomCheckout, remote]);
  await internal.startCorner({ cornerId: 'corner', parentRoomId: 'parent' });
  const turn = loop as unknown as {
    withCheckout(work: () => Promise<void>): Promise<void>;
    retainBackgroundClient(client: unknown): Promise<void>;
    commandContext: { current?: { reason: string } };
    options: { worktreePath: string; repository: { readOnly: boolean } };
  };
  return {
    root, remote, roomCheckout, identity, turn, posted,
    own: m35_agentCornerCheckoutPaths(root, 'corner', identity.publicKey),
    close: async () => { run.mockRestore(); await coordinator.shutdown(); await m35_rm(root, { recursive: true, force: true }); },
  };
}
return {
exec,
cornerFixture,
};
}
export function fixtureScope5() {



const roots: string[] = [];


m36_afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => m36_rm(root, { recursive: true, force: true })));
});
return {
roots,
};
}
export function fixtureScope7() {



const roots: string[] = [];


m37_afterEach(async () => {
  m37_vi.useRealTimers();
  m37_vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => m37_rm(root, { recursive: true, force: true })));
});
return {
roots,
};
}
export function fixtureScope10() {



/**
 * A corner is cut from a bare cache, and a bare clone writes no
 * `remote.origin.fetch`. Without that refspec a plain `git fetch origin main`
 * only moves FETCH_HEAD, so `origin/main` stays stale and an agent rebases or
 * diffs against an old main. These cases run real git against a real bare
 * remote, because a fake would only prove the fake agrees.
 */
const execFileAsync = move2_promisify(move2_execFile);


const roots: string[] = [];


move2_afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => move2_rm(root, { recursive: true, force: true }))),
);



const COMMITTER = {
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};



async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync('git', ['-C', cwd, ...args], {
    env: { ...process.env, ...COMMITTER },
  });
  return result.stdout.trim();
}



async function gitDir(gitCommonDir: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync('git', [`--git-dir=${gitCommonDir}`, ...args], {
    env: { ...process.env, ...COMMITTER },
  });
  return result.stdout.trim();
}



const WILDCARD_REFSPEC = '+refs/heads/*:refs/remotes/origin/*';



/** A bare remote with one commit on `main`, plus the seed it was cloned from. */
async function bareRemoteWithMain(root: string): Promise<{ remote: string; seed: string }> {
  const seed = move2_resolve(root, 'seed');
  await execFileAsync('git', ['init', '-b', 'main', seed]);
  await move2_writeFile(move2_resolve(seed, 'code.txt'), 'first\n');
  await git(seed, 'add', '.');
  await git(seed, 'commit', '-m', 'first');
  const bare = move2_resolve(root, 'remote.git');
  await execFileAsync('git', ['clone', '--bare', seed, bare]);
  return { remote: `file://${bare}`, seed };
}



/** Advance the bare remote's `main` to a fresh commit in its seed. */
async function advanceRemoteMain(seed: string, bare: string, message: string): Promise<string> {
  await move2_writeFile(move2_resolve(seed, 'code.txt'), `${message}\n`);
  await git(seed, 'commit', '-am', message);
  const head = await git(seed, 'rev-parse', 'HEAD');
  await gitDir(bare, 'fetch', seed, 'main');
  await gitDir(bare, 'update-ref', 'refs/heads/main', head);
  return head;
}



async function scratch(prefix: string): Promise<string> {
  const root = await move2_mkdtemp(move2_resolve(move2_tmpdir(), prefix));
  roots.push(root);
  return root;
}



async function materialize(supervisorRoot: string, remote: string, cornerId: string) {
  return move2_materializeCornerWorktree({
    cornerId,
    remote,
    targetBranch: 'main',
    featureBranch: `feature/${cornerId}`,
    token: 'unused',
    supervisorRoot,
    committer: { name: 'Helper', publicKey: 'a'.repeat(64) },
  });
}
return {
execFileAsync,
roots,
COMMITTER,
git,
gitDir,
WILDCARD_REFSPEC,
bareRemoteWithMain,
advanceRemoteMain,
scratch,
materialize,
};
}
export { execFile as m16_execFile, execFile as m35_execFile, execFile as move2_execFile } from 'node:child_process';
export { access as m16_access, mkdtemp as m16_mkdtemp, rm as m16_rm, writeFile as m16_writeFile, access as m35_access, mkdir as m35_mkdir, mkdtemp as m35_mkdtemp, rm as m35_rm, writeFile as m35_writeFile, mkdtemp as m36_mkdtemp, rm as m36_rm, mkdtemp as m37_mkdtemp, rm as m37_rm, mkdtemp as m38_mkdtemp, rm as m38_rm, mkdtemp as move2_mkdtemp, rm as move2_rm, writeFile as move2_writeFile } from 'node:fs/promises';
export { tmpdir as m16_tmpdir, tmpdir as m35_tmpdir, tmpdir as m36_tmpdir, tmpdir as m37_tmpdir, tmpdir as m38_tmpdir, tmpdir as move2_tmpdir } from 'node:os';
export { resolve as m16_resolve, resolve as m35_resolve, join as m36_join, resolve as m37_resolve, resolve as m38_resolve, resolve as move2_resolve } from 'node:path';
export { promisify as m16_promisify, promisify as m35_promisify, promisify as move2_promisify } from 'node:util';
export { afterEach as m16_afterEach, describe as m16_describe, expect as m16_expect, it as m16_it, describe as mergedDescribe16, expect as m35_expect, it as m35_it, vi as m35_vi, describe as mergedDescribe35, afterEach as m36_afterEach, describe as m36_describe, expect as m36_expect, it as m36_it, vi as m36_vi, describe as mergedDescribe36, afterEach as m37_afterEach, describe as m37_describe, expect as m37_expect, it as m37_it, vi as m37_vi, describe as mergedDescribe37, expect as m38_expect, it as m38_it, vi as m38_vi, describe as mergedDescribe38, afterEach as move2_afterEach, describe as move2_describe, expect as move2_expect, it as move2_it, describe as movedDescribe2 } from 'vitest';
export { cornerBranchIsSafeToDelete as m16_cornerBranchIsSafeToDelete, materializeCornerWorktree as m16_materializeCornerWorktree, removeCornerWorktreeAndBranches as m16_removeCornerWorktreeAndBranches, RoomRuntimeCoordinator as m35_RoomRuntimeCoordinator, materializeCornerWorktree as m35_materializeCornerWorktree, RoomRuntimeCoordinator as m36_RoomRuntimeCoordinator, RoomRuntimeCoordinator as m37_RoomRuntimeCoordinator, RoomRuntimeCoordinator as m38_RoomRuntimeCoordinator, materializeCornerWorktree as move2_materializeCornerWorktree } from './room-runtime.js';
export { MonolithCornerTurnLoop as m35_MonolithCornerTurnLoop } from './monolith-corner-turn.js';
export { agentCornerCheckoutPaths as m35_agentCornerCheckoutPaths } from './agent-corner-checkout.js';
export { readStorageOwners as m35_readStorageOwners, rememberStorageOwner as m35_rememberStorageOwner, markAgentStorageEnded as m35_markAgentStorageEnded, pruneEndedOwnerStorage as m35_pruneEndedOwnerStorage } from './storage-owners.js';
export { identityFromKey as m35_identityFromKey, identityFromKey as m36_identityFromKey, identityFromKey as m37_identityFromKey, identityFromKey as m38_identityFromKey } from './runtime.js';
export { DaemonApiError as m37_DaemonApiError } from './daemon-api-client.js';
export type { DaemonApiClient as m35_DaemonApiClient, DaemonApiClient as m36_DaemonApiClient, DaemonApiClient as m37_DaemonApiClient } from './daemon-api-client.js';
export type { AgentRuntimeRecord as m35_AgentRuntimeRecord, AgentRuntimeRecord as m36_AgentRuntimeRecord, AgentRuntimeRecord as m37_AgentRuntimeRecord, AgentRuntimeRecord as m38_AgentRuntimeRecord } from './runtime.js';
export type { CornerWorktree as m38_CornerWorktree } from './room-runtime.js';
