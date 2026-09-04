import { disableAgentService, type SystemdRunner } from './systemd.js';
import { removeAgentRuntime, type AgentRuntimeRecord } from './runtime.js';

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
  options: { env?: NodeJS.ProcessEnv; run?: SystemdRunner } = {},
): Promise<string> {
  const env = options.env ?? process.env;
  if (env.BEELINE_MANAGED_BY_SYSTEMD === '1') {
    // Disable before the directory moves: a failure here must not cost the
    // operator the archive, but a unit left enabled would restart into a
    // runtime that is no longer there.
    await disableAgentService(runtime.agent.publicKey, {
      stop: false,
      ...(options.run ? { run: options.run } : {}),
    }).catch((error) =>
      console.error('[thin-core] could not disable deliberately removed unit:', error),
    );
  }
  return removeAgentRuntime(runtime);
}
