
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
