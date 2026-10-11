import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { supervisor } from './helper-service.js';
import { LAUNCHD_HELPER_LABEL, launchdHelperPlistPath } from './launchd.js';
import { findObsoleteAssetCopies, removeObsoleteAssetCopiesAtStartup } from './obsolete-agent-assets.js';
import { defaultSupervisorRoot, runningHelperPid, startMachineHelper } from './runtime.js';
import { extendSystemdStartTimeout, SYSTEMD_HELPER_UNIT_NAME } from './systemd.js';

const execFileAsync = promisify(execFile);
const requestPath = (root: string) => resolve(root, 'beeline/helper/cleanup-shared-home.request');
const resultPath = (root: string) => resolve(root, 'beeline/helper/cleanup-shared-home.result');

export async function requestStartupCleanup(root: string): Promise<string> {
  const nonce = randomUUID();
  await mkdir(resolve(root, 'beeline/helper'), { recursive: true, mode: 0o700 });
  await writeFile(requestPath(root), nonce, { flag: 'wx', mode: 0o600 });
  return nonce;
}

/** Runs before the helper records its PID or starts any agent. */
export async function applyRequestedStartupCleanup(root: string): Promise<void> {
  const nonce = await readFile(requestPath(root), 'utf8').catch(() => undefined);
  if (!nonce) return;
  // A large old cache can take longer than the service's normal 90s startup
  // deadline to hash twice. Keep only this explicitly requested startup alive.
  await extendSystemdStartTimeout(90_000);
  const heartbeat = setInterval(() => { void extendSystemdStartTimeout(90_000); }, 15_000);
  let result: { nonce: string; removed: number; apparentBytes: number; uniqueBytes: number; error?: string };
  try {
    const copies = await removeObsoleteAssetCopiesAtStartup(root);
    result = {
      nonce, removed: copies.length,
      apparentBytes: copies.reduce((sum, item) => sum + item.apparentBytes, 0),
      uniqueBytes: copies.reduce((sum, item) => sum + item.uniqueBytes, 0),
    };
  } catch (error) {
    result = { nonce, removed: 0, apparentBytes: 0, uniqueBytes: 0,
      error: error instanceof Error ? error.message : String(error) };
  } finally { clearInterval(heartbeat); }
  await writeFile(resultPath(root), JSON.stringify(result), { mode: 0o600 });
  await rm(requestPath(root), { force: true });
}

async function waitForResult(root: string, nonce: string): Promise<string> {
  const deadline = Date.now() + 30 * 60_000;
  while (Date.now() < deadline) {
    const result = await readFile(resultPath(root), 'utf8').catch(() => undefined);
    if (result) {
      const parsed = JSON.parse(result) as { nonce: string; removed: number; apparentBytes: number; uniqueBytes: number; error?: string };
      if (parsed.nonce === nonce) {
        if (parsed.error) throw new Error(parsed.error);
        return `removed: ${parsed.removed} exact cache copies; ${parsed.apparentBytes} apparent bytes; ${parsed.uniqueBytes} hardlink-aware unique bytes`;
      }
    }
    await new Promise((done) => setTimeout(done, 200));
  }
  throw new Error('helper did not report startup cleanup within 30 minutes');
}

/** Explicit operator operation; never called by normal helper startup. */
export async function runCleanupSharedHomeCommand(
  env: NodeJS.ProcessEnv = process.env,
  apply = false,
): Promise<string> {
  const root = defaultSupervisorRoot(env);
  if (!apply) {
    const copies = await findObsoleteAssetCopies(root);
    return `reclaimable: ${copies.length} exact cache copies; ${copies.reduce((sum, item) => sum + item.apparentBytes, 0)} apparent bytes; ${copies.reduce((sum, item) => sum + item.uniqueBytes, 0)} hardlink-aware unique bytes`;
  }
  const kind = supervisor(env);
  if (!(await runningHelperPid(root))) throw new Error('cleanup --apply requires a running machine helper');
  if (kind === 'systemd') await execFileAsync('systemctl', ['--user', 'stop', SYSTEMD_HELPER_UNIT_NAME]);
  else if (kind === 'launchd') {
    const uid = process.getuid?.();
    if (uid === undefined) throw new Error('launchd cleanup needs a numeric user id');
    await execFileAsync('launchctl', ['bootout', `gui/${uid}/${LAUNCHD_HELPER_LABEL}`]);
  } else {
    const pid = await runningHelperPid(root);
    if (pid) process.kill(pid, 'SIGTERM');
  }
  for (let attempt = 0; attempt < 100; attempt++) {
    if (!(await runningHelperPid(root))) break;
    if (attempt === 99) throw new Error('helper did not stop before cleanup');
    await new Promise((done) => setTimeout(done, 100));
  }
  const nonce = await requestStartupCleanup(root);
  if (kind === 'systemd') await execFileAsync('systemctl', ['--user', 'start', SYSTEMD_HELPER_UNIT_NAME]);
  else if (kind === 'launchd') {
    const uid = process.getuid?.();
    if (uid === undefined) throw new Error('launchd cleanup needs a numeric user id');
    await execFileAsync('launchctl', ['bootstrap', `gui/${uid}`, launchdHelperPlistPath(env)]);
  } else await startMachineHelper({ env });
  return waitForResult(root, nonce);
}
