import { mkdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { AcpClient } from './acp.js';
import { harnessStateDirsFromEnv, prepareRoomAgentHome } from './agent-home.js';
import { AgentToolHostBroker } from './agent-tool-host-broker.js';
import { credentialMaskPaths, harnessHomeStateDirs, wrapAgentCommand } from './bwrap-sandbox.js';
import type { BodyConfig } from './config.js';
import { applyAgentModelSelection, parseAdvertisedConfigOptions } from './model-config.js';
import { piMcpDirectToolSelection, preparePiMcpSession } from './pi-mcp-session.js';

// The systemd unit's start deadline is 90s. Initialize gets 10s, session/new
// gets 20s, and the real turn gets 45s, preserving 15s for home/sandbox setup
// and teardown before the service manager could kill the successor. Pi cold
// loads its release-owned extension during session/new; keep that compilation
// off the faster protocol-initialize deadline.
export const UPDATE_PROBE_SESSION_TIMEOUT_MS = 10_000;
export const UPDATE_PROBE_SESSION_OPEN_TIMEOUT_MS = 20_000;
export const UPDATE_PROBE_TURN_TIMEOUT_MS = 45_000;

export type UpdateFunctionalProbeFailure =
  | 'model-unavailable'
  | 'sandbox-unavailable'
  | 'session-start-failed'
  | 'turn-failed'
  | 'native-tool-missing';

export class UpdateFunctionalProbeError extends Error {
  readonly code = 'BEELINE_UPDATE_FUNCTIONAL_PROBE_FAILED';

  constructor(
    readonly reason: UpdateFunctionalProbeFailure,
    detail: string,
    options?: ErrorOptions,
  ) {
    super(`functional update probe failed (${reason}): ${detail}`, options);
    this.name = 'UpdateFunctionalProbeError';
  }
}

export interface UpdateFunctionalProbeResult {
  harness: string;
  sandboxed: boolean;
  sessionStarted: true;
  turnCompleted: true;
  nativeTools: readonly ['read_mandate'];
}

/**
 * Exercise the exact production ACP boundary before a successor may announce
 * READY. The probe is local-only: it creates no Room event and publishes no
 * model prose. Its one mounted tool is backed by an in-process capability.
 */
export async function runUpdateFunctionalProbe(input: {
  config: BodyConfig;
  runtimeDir: string;
  releaseId: string;
  /** `sandbox: off` is the sole supported reason for an unwrapped probe. */
  sandboxRequired: boolean;
  /** Protocol initialize timeout. Also controls session/new when explicitly set alone. */
  sessionTimeoutMs?: number;
  /** Test seam for the separate cold session/new budget. */
  sessionOpenTimeoutMs?: number;
  turnTimeoutMs?: number;
  /** Test seam; production always resolves the proxy owned by the running bundle. */
  proxyEntrypoint?: string;
}): Promise<UpdateFunctionalProbeResult> {
  const command = input.config.agentCommand ?? input.config.agentBinary;
  const harness = input.config.agentKind ?? command;
  if (input.config.modelUnavailable) {
    throw new UpdateFunctionalProbeError('model-unavailable', input.config.modelUnavailable.detail);
  }
  if (input.sandboxRequired && !input.config.bwrapPath) {
    throw new UpdateFunctionalProbeError(
      'sandbox-unavailable',
      'the configured bubblewrap boundary did not pass its startup self-test',
    );
  }

  const root = resolve(input.runtimeDir, 'update-functional-probe');
  const cwd = resolve(root, 'checkout');
  const homeRoot = resolve(root, 'agent-home');
  await rm(root, { recursive: true, force: true });
  await mkdir(cwd, { recursive: true, mode: 0o700 });

  const calls: string[] = [];
  const broker = new AgentToolHostBroker(input.proxyEntrypoint);
  let client: AcpClient | undefined;
  try {
    const server = await broker.mcpServer({
      channelId: `update-probe:${input.releaseId}`,
      invoke: async (tool) => {
        calls.push(tool);
        return {
          schema_version: 2,
          generation: { event_id: '0'.repeat(64), generation: 1 },
          grants: [],
          defaults: [],
          blockers: [],
        };
      },
    });
    let agentEnv = {
      ...input.config.agentEnv,
      ...(await prepareRoomAgentHome({
        root: homeRoot,
        operatorHome: input.config.operatorHome ?? homedir(),
        sharedSkills: input.config.sharedSkills ?? [],
        skillReleaseId: input.releaseId,
        failClosed: true,
      })),
    };
    if (input.config.agentKind === 'pi' && agentEnv.PI_CODING_AGENT_DIR) {
      agentEnv = {
        ...agentEnv,
        PI_CODING_AGENT_DIR: await preparePiMcpSession({
          baseDir: agentEnv.PI_CODING_AGENT_DIR,
          channelId: `update-probe:${input.releaseId}`,
          mcpServers: [server],
        }),
        MCP_DIRECT_TOOLS: piMcpDirectToolSelection([server]),
      };
    }

    let spawnCommand = { command, args: [...(input.config.agentArgs ?? [])] };
    if (input.config.bwrapPath) {
      const { stateDirs, tmpDir } = harnessStateDirsFromEnv(agentEnv);
      const operatorHome = input.config.operatorHome ?? homedir();
      const homeStateDirs = harnessHomeStateDirs(command, agentEnv.HOME ?? operatorHome);
      await Promise.all(homeStateDirs.map((dir) => mkdir(dir, { recursive: true })));
      spawnCommand = wrapAgentCommand({
        bwrapPath: input.config.bwrapPath,
        spec: {
          mode: 'readonly',
          cwd,
          harnessStateDirs: stateDirs,
          harnessHomeStateDirs: homeStateDirs,
          maskPaths: credentialMaskPaths(input.config.sandboxMaskPaths, operatorHome),
          ...(tmpDir ? { tmpDir } : {}),
        },
        command,
        args: input.config.agentArgs,
      });
    }

    client = new AcpClient({
      agentCommand: spawnCommand.command,
      agentArgs: spawnCommand.args,
      agentLabel: command,
      agentEnv,
      agentCwd: cwd,
      autoApprovePermissions: true,
    });
    const sessionTimeoutMs = input.sessionTimeoutMs ?? UPDATE_PROBE_SESSION_TIMEOUT_MS;
    const sessionOpenTimeoutMs =
      input.sessionOpenTimeoutMs ?? input.sessionTimeoutMs ?? UPDATE_PROBE_SESSION_OPEN_TIMEOUT_MS;
    try {
      await client.start(sessionTimeoutMs);
      const opened = await client.sessionNew({
        cwd,
        mcpServers: [server],
        systemPrompt:
          'This is Beeline update validation. Call read_mandate once, then answer only READY.',
        mode: 'readonly',
        timeoutMs: sessionOpenTimeoutMs,
      });
      if (input.config.modelSelection) {
        await applyAgentModelSelection(
          client,
          opened.sessionId,
          parseAdvertisedConfigOptions(opened.raw),
          input.config.modelSelection,
        );
      }
      try {
        await client.sessionPrompt(
          opened.sessionId,
          'Call the mounted Beeline read_mandate tool exactly once, then reply READY.',
          input.turnTimeoutMs ?? UPDATE_PROBE_TURN_TIMEOUT_MS,
        );
      } catch (error) {
        throw new UpdateFunctionalProbeError(
          'turn-failed',
          error instanceof Error ? error.message : String(error),
          { cause: error },
        );
      }
    } catch (error) {
      if (error instanceof UpdateFunctionalProbeError) throw error;
      throw new UpdateFunctionalProbeError(
        'session-start-failed',
        error instanceof Error ? error.message : String(error),
        { cause: error },
      );
    }
    if (calls.length !== 1 || calls[0] !== 'read_mandate') {
      throw new UpdateFunctionalProbeError(
        'native-tool-missing',
        `expected one read_mandate call, observed ${calls.join(', ') || 'none'}`,
      );
    }
    return {
      harness,
      sandboxed: Boolean(input.config.bwrapPath),
      sessionStarted: true,
      turnCompleted: true,
      nativeTools: ['read_mandate'],
    };
  } finally {
    await client?.stop().catch(() => undefined);
    await broker.close();
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
}
