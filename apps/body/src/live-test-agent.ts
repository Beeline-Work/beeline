import type { AcpClient } from './acp.js';
import { resolveAgentCommand, type AgentKind } from './agent-command.js';
import {
  hasLlmCredentials,
  loadBodyConfig,
  type BodyConfig,
} from './config.js';

type LiveConfigOptions = Parameters<typeof loadBodyConfig>[0];
type AcpClientOptions = ConstructorParameters<typeof AcpClient>[0];

/** Load a live-test config using the explicitly selected installed ACP runtime. */
export function loadLiveBodyConfig(options: LiveConfigOptions): BodyConfig {
  const selected = process.env.BUZZY_LIVE_AGENT_KIND as AgentKind | undefined;
  return loadBodyConfig({
    ...options,
    ...(selected ? { agent: resolveAgentCommand({ kind: selected }) } : {}),
  });
}

/** Installed ACP runtimes carry their own auth; the reference runtime needs LLM env. */
export function hasLiveAgent(config: BodyConfig): boolean {
  return config.agentKind !== 'reference' || hasLlmCredentials(config.agentEnv);
}

/** Preserve the selected runtime's complete command and argv for direct ACP clients. */
export function liveAcpClientOptions(config: BodyConfig): AcpClientOptions {
  return {
    agentCommand: config.agentCommand ?? config.agentBinary,
    agentArgs: config.agentArgs,
    agentEnv: config.agentEnv,
    autoApprovePermissions: true,
  };
}
