import { mkdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { AcpClient } from './acp.js';
import { harnessStateDirsFromEnv, prepareRoomAgentHome } from './agent-home.js';
import { credentialMaskPaths, harnessHomeStateDirs, wrapAgentCommand } from './bwrap-sandbox.js';
import type { BodyConfig } from './config.js';
import {
  agentArgsWithModelSelection,
  applyAgentModelSelection,
  isGrokAgentCommand,
  parseAdvertisedConfigOptions,
} from './model-config.js';

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
  | 'turn-failed';

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
  nativeTools: readonly [];
}

/**
 * Exercise the exact production ACP boundary before a successor may announce
 * READY. The probe is local-only: it creates no Room event and publishes no
 * model prose.
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

  let client: AcpClient | undefined;
  try {
    const agentEnv = {
      ...input.config.agentEnv,
      ...(await prepareRoomAgentHome({
        root: homeRoot,
        operatorHome: input.config.operatorHome ?? homedir(),
        sharedSkills: input.config.sharedSkills ?? [],
        skillReleaseId: input.releaseId,
        failClosed: true,
      })),
    };
    const selectedAgent = {
      kind: input.config.agentKind,
      command,
      args: input.config.agentArgs ?? [],
    };
    let spawnCommand = {
      command,
      args: agentArgsWithModelSelection(selectedAgent, input.config.modelSelection),
    };
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
        args: spawnCommand.args,
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
        mcpServers: [],
        systemPrompt: 'This is Beeline update validation. Answer only READY.',
        mode: 'readonly',
        timeoutMs: sessionOpenTimeoutMs,
      });
      if (input.config.modelSelection) {
        await applyAgentModelSelection(
          client,
          opened.sessionId,
          parseAdvertisedConfigOptions(
            opened.raw,
            input.config.modelSelection.model,
            isGrokAgentCommand(selectedAgent),
          ),
          input.config.modelSelection,
        );
      }
      try {
        const served = await client.sessionPrompt(
          opened.sessionId,
          'Reply READY.',
          input.turnTimeoutMs ?? UPDATE_PROBE_TURN_TIMEOUT_MS,
        );
        if (!served.agentText.trim()) {
          throw new UpdateFunctionalProbeError(
            'turn-failed',
            'the harness completed a session/prompt without an agent answer',
          );
        }
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
    return {
      harness,
      sandboxed: Boolean(input.config.bwrapPath),
      sessionStarted: true,
      turnCompleted: true,
      nativeTools: [],
    };
  } finally {
    await client?.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
}
