import type { AgentCommand, AgentKind } from './agent-command.js';
import { loadBodyConfig } from './config.js';
import { activateDaemonTransport, type DaemonFetch } from './daemon-api-client.js';
import { validateAgentModelSelection } from './model-catalog.js';
import { selectPairAgentCommand } from './pair-agent-selection.js';
import {
  identityFromKey,
  launchRuntimeDaemon,
  stageMonolithAgentRuntime,
} from './runtime.js';
import { installAgentService } from './systemd.js';

const DEFAULT_BODY_IDENTITY_NAME = 'beeline-body';

export interface DevicePairingGrant {
  agentSecretKey: string;
  bodySecretKey: string;
  agentName: string;
  harness: Exclude<AgentKind, 'reference' | 'custom'>;
  model: string;
  soul: string;
  workspaceId: string;
  workspaceName: string;
  pairedBy: string;
  monolithBaseUrl: string;
  daemonExchangeToken: string;
  llmEnvFile?: string;
}

export interface DeviceConnectionResult {
  runtime: Awaited<ReturnType<typeof stageMonolithAgentRuntime>>['runtime'];
  configPath: string;
  pid: number;
}

/** Complete app-authorized onboarding from the installed canonical launcher. */
export async function completeDevicePairing(
  grant: DevicePairingGrant,
  options: {
    fetchImpl?: DaemonFetch;
    supervisorRoot?: string;
    selectedAgent?: AgentCommand;
    localConfig?: { agentBinary: string; mcpBinary: string; agentEnv: Record<string, string> };
    validateSelection?: (
      agent: AgentCommand,
      env: Record<string, string>,
      selection: { model?: string; effort?: string },
    ) => Promise<void>;
    launch?: (configPath: string, agentPubkey: string) => Promise<number>;
  } = {},
): Promise<DeviceConnectionResult> {
  const selectedAgent =
    options.selectedAgent ??
    (await selectPairAgentCommand({
      explicitKind: grant.harness,
      env: process.env,
      cwd: process.cwd(),
      interactive: true,
      confirmInstall: async () => true,
    }));
  const localConfig =
    options.localConfig ??
    loadBodyConfig({
      workspaceRoot: process.cwd(),
      ...(grant.llmEnvFile ? { llmEnvFile: grant.llmEnvFile } : {}),
      agent: selectedAgent,
    });
  await (options.validateSelection ?? validateAgentModelSelection)(
    selectedAgent,
    localConfig.agentEnv,
    { model: grant.model },
  );
  const agentIdentity = identityFromKey(grant.agentSecretKey, grant.agentName);
  const staged = await stageMonolithAgentRuntime({
    workspaceId: grant.workspaceId,
    pairedBy: grant.pairedBy,
    monolithBaseUrl: grant.monolithBaseUrl,
    daemonExchangeToken: grant.daemonExchangeToken,
    ...(grant.llmEnvFile ? { llmEnvFile: grant.llmEnvFile } : {}),
    agentBinary: localConfig.agentBinary,
    agentKind: selectedAgent.kind,
    agentCommand: selectedAgent.command,
    agentArgs: selectedAgent.args,
    modelSelection: { model: grant.model },
    mcpBinary: localConfig.mcpBinary,
    agentIdentity,
    bodyIdentity: identityFromKey(grant.bodySecretKey, DEFAULT_BODY_IDENTITY_NAME),
    ...(options.supervisorRoot ? { supervisorRoot: options.supervisorRoot } : {}),
  });
  const activated = await activateDaemonTransport(staged.configPath, options.fetchImpl);
  if (!activated) throw new Error('monolith daemon transport activation failed');
  let pid: number;
  try {
    pid = await (
      options.launch ??
      (async (configPath, publicKey) =>
        process.platform === 'linux' && process.env.BEELINE_SYSTEMD_USER !== '0'
          ? installAgentService(publicKey)
          : launchRuntimeDaemon(configPath))
    )(staged.configPath, agentIdentity.publicKey);
  } catch (error) {
    throw new Error(
      `agent ${agentIdentity.publicKey} is connected, but its daemon did not start: ${
        error instanceof Error ? error.message : String(error)
      }. Run \`beeline start --agent ${agentIdentity.publicKey}\`.`,
      { cause: error },
    );
  }
  return { runtime: activated.runtime, configPath: staged.configPath, pid };
}
