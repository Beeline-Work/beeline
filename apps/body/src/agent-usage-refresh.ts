import type { DaemonApiClient } from './daemon-api-client.js';
import type { AgentKind } from './agent-command.js';
import { HarnessQuotaReader, quotaAxiProvider } from './harness-quota.js';
import { agentOpenRouterKey, readOpenRouterKeyUsage } from './openrouter-key-usage.js';

/** One manual read per agent at a time, using its configured harness account. */
export function createUsageRefresh(options: {
  api: Pick<DaemonApiClient, 'execute'>;
  agentId: string;
  kind?: AgentKind;
  env: Record<string, string>;
  free?: boolean;
}): () => Promise<void> {
  const { api, agentId, kind, env } = options;
  const reader = new HarnessQuotaReader({
    agentId, post: (usage) => api.execute('postAgentUsage', { agentId, usage }),
  });
  let pending: Promise<void> | undefined;
  return () => {
    if (options.free) return Promise.resolve();
    pending ??= (async () => {
      const selection = await api.execute('getAgentConfiguration', { agentId });
      const key = agentOpenRouterKey(kind, selection.model, env);
      if (key) {
        const usage = await readOpenRouterKeyUsage(key, { force: true });
        if (usage) await api.execute('postAgentUsage', { agentId, usage });
      } else {
        await reader.publish(quotaAxiProvider(kind, false), env, true);
      }
    })().catch((error) => console.error('[agent-usage] refresh failed', error))
      .finally(() => { pending = undefined; });
    return pending;
  };
}
