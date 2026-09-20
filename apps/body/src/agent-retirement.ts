import { mkdir, rename } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { cleanupAgentService, type SystemdRunner } from './systemd.js';
import { runtimeDirectory, type AgentRuntimeRecord } from './runtime.js';

/**
 * What a helper does to itself once the server has definitively said its
 * agent is gone (`isAgentRemovedError`, or a bootstrap that no longer lists
 * the Workspace after `REMOVAL_CONFIRMATION_READS`).
 *
 * It is the same teardown a confirmed removal from the app performs, in the
 * same order: the unit is disabled so `Restart=always` cannot resurrect a
 * daemon with revoked tokens, and the runtime directory moves aside into
 * `deleted-runtimes/` rather than being deleted, so an operator can still see
 * what was paired here. Nothing about it may run on uncertainty — the caller
 * owns that judgement, and only a settled removal answer reaches here.
 */
export async function retireRemovedAgent(
  runtime: AgentRuntimeRecord,
  options: { run?: SystemdRunner } = {},
): Promise<string> {
  const deletedRoot = resolve(runtime.supervisorRoot, 'beeline', 'deleted-runtimes');
  const target = resolve(deletedRoot, `${runtime.agent.publicKey}-${Date.now()}`);
  return relocateAgentRuntime(runtime, target, {
    ...(options.run ? { run: options.run } : {}),
  });
}

/**
 * Move a runtime off this host only after its corresponding unit is disabled
 * and its failed state is cleared. A cleanup failure leaves the source
 * recoverable.
 */
export async function relocateAgentRuntime(
  runtime: AgentRuntimeRecord,
  target: string,
  options: { run?: SystemdRunner } = {},
): Promise<string> {
  const source = runtimeDirectory(runtime.supervisorRoot, runtime.agent.publicKey);
  const destination = resolve(target);
  if (destination === source || destination.startsWith(`${source}/`)) {
    throw new Error('agent runtime destination must be outside the live runtime');
  }
  if (process.platform === 'linux') {
    await cleanupAgentService(runtime.agent.publicKey, {
      ...(options.run ? { run: options.run } : {}),
    });
  }
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await rename(source, destination);
  return destination;
}
