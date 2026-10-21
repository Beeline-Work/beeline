import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { runMachineHelper } from '../apps/body/dist/machine-helper.js';
import { helperStatusPath } from '../apps/body/dist/helper-status.js';
import { identityFromKey, stageMonolithAgentRuntime, writeDaemonPidRecord } from '../apps/body/dist/runtime.js';
import { hostPlatformKey, readUpdateState, SelfUpdateManager } from '../apps/body/dist/self-update.js';

// Reproduction HELPER-7: built helper, isolated installation, real legacy owner,
// local publication server. No production service manager or runtime is used.
const root = await mkdtemp(resolve(tmpdir(), 'beeline-migration-proof-'));
const signals = new EventEmitter();
let owner;
let running;
let deadline;
let manifestReads = 0;
const server = createServer();
try {
  const layout = { libDir: resolve(root, 'lib/beeline'),
    releasesRoot: resolve(root, 'lib/beeline-releases'), binDir: resolve(root, 'bin') };
  await mkdir(resolve(layout.releasesRoot, 'old/lib/beeline'), { recursive: true });
  await writeFile(resolve(layout.releasesRoot, 'old/lib/beeline/bundle.json'),
    JSON.stringify({ version: 'v0.1.89', commit: 'old' }));
  await symlink('beeline-releases/old', layout.libDir);
  const published = resolve(root, 'published');
  await mkdir(resolve(published, 'lib/beeline/codegraph/bin'), { recursive: true });
  await writeFile(resolve(published, 'bundle.json'), JSON.stringify({ version: 'v0.1.94', commit: 'new' }));
  await writeFile(resolve(published, 'lib/beeline/beeline-cli.mjs'), 'export {};');
  await writeFile(resolve(published, 'lib/beeline/pi-mcp-adapter.mjs'), 'export {};');
  await writeFile(resolve(published, 'lib/beeline/codegraph/bin/codegraph'), '#!/bin/sh\nexit 0\n');
  const archivePath = resolve(root, 'bundle.tar.gz');
  execFileSync('tar', ['-czf', archivePath, '-C', published, '.']);
  const archive = await readFile(archivePath);
  server.on('request', (request, response) => {
    if (request.url === '/manifest.json') {
      manifestReads++;
      response.end(JSON.stringify({ schemaVersion: 1, sourceCommit: 'new', version: 'v0.1.94',
        bundles: { [hostPlatformKey()]: { file: 'bundle.tar.gz',
          sha256: createHash('sha256').update(archive).digest('hex') } } }));
    } else if (request.url === '/bundle.tar.gz') response.end(archive);
    else { response.statusCode = 404; response.end(); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const env = { ...process.env, HOME: root, XDG_STATE_HOME: root,
    XDG_CONFIG_HOME: resolve(root, 'config'), BEELINE_SYSTEMD_USER: '0',
    BEELINE_LAUNCHD_USER: '0', BEELINE_MANAGED_BY_SYSTEMD: '0', BEELINE_UPDATE_DISABLE: '0',
    BEELINE_LIB_DIR: layout.libDir,
    BEELINE_UPDATE_MANIFEST_URL: `http://127.0.0.1:${server.address().port}/manifest.json` };
  const staged = await stageMonolithAgentRuntime({ workspaceId: 'proof', pairedBy: 'proof',
    daemonExchangeToken: `bde_${'a'.repeat(43)}`, agentBinary: '/nonexistent', agentKind: 'codex',
    agentCommand: '/nonexistent', agentArgs: [], mcpBinary: 'unused',
    agentIdentity: identityFromKey('11'.repeat(32), 'Proof'),
    bodyIdentity: identityFromKey('44'.repeat(32), 'Body'), supervisorRoot: root });
  owner = spawn(process.execPath, ['-e',
    "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); process.send('ready');"],
  { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  await once(owner, 'message');
  await writeDaemonPidRecord(staged.configPath, owner.pid);
  let agentStarts = 0;
  running = runMachineHelper({ configPaths: [staged.configPath], env, signals,
    runAgent: async () => { agentStarts++; return 'stopped'; }, exitProcess: () => {},
    runUpdateWorker: async () => {
      await new SelfUpdateManager({ layout, stageOnly: true, env, logger: () => {} }).checkAndApply();
    } });
  deadline = setTimeout(() => signals.emit('SIGTERM'), 3_000);
  const result = await running;
  assert.equal(result.reason, 'update');
  assert.equal(agentStarts, 0);
  assert.equal(manifestReads, 1);
  assert.equal((await readUpdateState(layout)).stagedReleaseId, 'new');
  assert.equal(JSON.parse(await readFile(helperStatusPath(root), 'utf8')).desiredRelease, 'new');
  assert.equal(owner.signalCode, null);
  assert.equal(owner.exitCode, null);
  console.log('Reproduction HELPER-7 PASS: built helper staged v0.1.94 and exited for update while the verified legacy owner remained alive; zero duplicate agent starts.');
} finally {
  clearTimeout(deadline);
  signals.emit('SIGTERM');
  await running;
  if (owner && owner.exitCode === null && owner.signalCode === null) {
    owner.kill('SIGKILL');
    await once(owner, 'exit');
  }
  await new Promise(done => server.close(done));
  await rm(root, { recursive: true, force: true });
}
