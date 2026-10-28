import type { UsageRefreshOutcome } from '@beeline/api-contract/daemon';
import type { DaemonApiClient } from './daemon-api-client.js';
import type { AgentKind } from './agent-command.js';
import { HarnessQuotaReader, quotaAxiProvider } from './harness-quota.js';
import { agentOpenRouterKey, readOpenRouterKeyUsage } from './openrouter-key-usage.js';

/**
 * One manual read per agent at a time, using its configured harness account.
 * A request with an id gets an answer saying what the read found; older
 * servers send none and only see the posted read. `attach` joins the agent to
 * its plan account when the helper starts, so an idle agent shows its
 * siblings' reads; agents on one login share one vendor read.
 */
export function createUsageRefresh(options: {
  api: Pick<DaemonApiClient, 'execute'>;
  agentId: string;
  kind?: AgentKind;
  env: Record<string, string>;
  free?: boolean;
  reader?: HarnessQuotaReader;
}): ((requestId?: string) => Promise<void>) & { attach: () => Promise<void> } {
  const { api, agentId, kind, env } = options;
  const reader = options.reader ?? new HarnessQuotaReader({
    agentId, post: (usage) => api.execute('postAgentUsage', { agentId, usage }),
  });
  let pending: Promise<UsageRefreshOutcome> | undefined;
  const read = async (): Promise<UsageRefreshOutcome> => {
    // Beeline counts the free allowance itself, so it is always current.
    if (options.free) return { status: 'fresh' };
    const selection = await api.execute('getAgentConfiguration', { agentId });
    const key = agentOpenRouterKey(kind, selection.model, env);
    if (key) {
      const usage = await readOpenRouterKeyUsage(key, { force: true });
      if (!usage) return { status: 'failed', reason: "OpenRouter didn't answer" };
      await api.execute('postAgentUsage', { agentId, usage });
      return { status: 'fresh' };
    }
    return (await reader.publish(quotaAxiProvider(kind, false), env, true)) ??
      { status: 'failed', reason: "this harness doesn't report usage" };
  };
  const attach = async () => {
    if (options.free) return;
    try {
      const selection = await api.execute('getAgentConfiguration', { agentId });
      if (agentOpenRouterKey(kind, selection.model, env)) return;
      await reader.publish(quotaAxiProvider(kind, false), env);
    } catch (error) {
      console.error('[agent-usage] attach failed', error);
    }
  };
  return Object.assign(async (requestId?: string) => {
    pending ??= read()
      .catch((error): UsageRefreshOutcome => {
        console.error('[agent-usage] refresh failed', error);
        return { status: 'failed', reason: 'refresh failed' };
      })
      .finally(() => { pending = undefined; });
    const outcome = await pending;
    if (!requestId) return;
    await api.execute('answerUsageRefresh', { agentId, requestId, outcome })
      .catch((error) => console.error('[agent-usage] refresh answer failed', error));
  }, { attach });
}
