import { mkdir, rename } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { cleanupLaunchdAgentService, type LaunchdRunner } from './launchd.js';
import { cleanupAgentService, type SystemdRunner } from './systemd.js';
import { markAgentStorageEnded, pruneEndedOwnerStorage } from './storage-owners.js';
import { runtimeDirectory, type AgentRuntimeRecord } from './runtime.js';

/** Retire only after a settled server answer and the hosted agent has drained.
 * An in-use folder stays fenced by an ended-owner fact for the next idle pass. */
export async function retireRemovedAgent(
  runtime: AgentRuntimeRecord,
  options: { run?: SystemdRunner | LaunchdRunner } = {},
): Promise<string> {
  if (process.platform === 'linux') await cleanupAgentService(runtime.agent.publicKey, { ...(options.run ? { run: options.run as SystemdRunner } : {}) });
  else if (process.platform === 'darwin') await cleanupLaunchdAgentService(runtime.agent.publicKey, { ...(options.run ? { run: options.run as LaunchdRunner } : {}) });
  await markAgentStorageEnded(runtime);
  await pruneEndedOwnerStorage(runtime.supervisorRoot);
  return runtimeDirectory(runtime.supervisorRoot, runtime.agent.publicKey);
}

/**
 * Move a runtime off this host only after its corresponding unit is disabled
 * and its failed state is cleared. A cleanup failure leaves the source
 * recoverable.
 */
export async function relocateAgentRuntime(
  runtime: AgentRuntimeRecord,
  target: string,
  options: { run?: SystemdRunner | LaunchdRunner } = {},
): Promise<string> {
  const source = runtimeDirectory(runtime.supervisorRoot, runtime.agent.publicKey);
  const destination = resolve(target);
  if (destination === source || destination.startsWith(`${source}/`)) {
    throw new Error('agent runtime destination must be outside the live runtime');
  }
  if (process.platform === 'linux') {
    await cleanupAgentService(runtime.agent.publicKey, {
      ...(options.run ? { run: options.run as SystemdRunner } : {}),
    });
  } else if (process.platform === 'darwin') {
    await cleanupLaunchdAgentService(runtime.agent.publicKey, {
      ...(options.run ? { run: options.run as LaunchdRunner } : {}),
    });
  }
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await rename(source, destination);
  return destination;
}
