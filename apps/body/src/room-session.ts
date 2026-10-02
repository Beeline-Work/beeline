import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { agentSkillDir } from './agent-home.js';
import { squireRegistryDir } from './squire-session-registry.js';
import type { McpServerWire } from './acp.js';
import type { BodyConfig } from './config.js';
import type { DaemonApiClient } from './daemon-api-client.js';
import type { GrantRunnerEndpoint } from './grant-runner.js';
import { BEELINE_AGENT_MCP_SERVER_NAME, READ_ONLY_MCP_SERVER_NAME } from './read-only-policy.js';

export class ReadOnlyToolsUnavailableError extends Error {
  override readonly name = 'ReadOnlyToolsUnavailableError';
}

/** Daemon-backed corner controls mounted in Rooms and edit corners. */
export function beelineAgentMcpServer(
  config: BodyConfig,
  api: DaemonApiClient,
  context: {
    roomId: string;
    turnContextPath?: string;
    workspaceId: string;
    cornerId?: string;
    /** Repository-corner authors may close landed or abandoned work. No-code
     *  corners stay open until a human uses the phone's structured close. */
    agentMayCloseCorner?: boolean;
    /** A repository-backed no-code corner may take its one-way code upgrade. */
    agentMayUpgradeCorner?: boolean;
    /** This corner session belongs to the parent Room's configured reviewer. */
    reviewer?: boolean;
    /** The corner's lane. A code-lane corner mounts approve_merge on every
     *  turn; the server decides whether the caller is the configured reviewer. */
    lane?: 'code' | 'no_code';
    attachRoot?: string;
    /** The session's whole writable home overlay (or, absent one, its
     *  TMPDIR): a second legal post_artifact root covering anywhere the
     *  harness itself could have put a file it generated. */
    attachScratchRoot?: string;
    directMessage?: boolean;
    /** The daemon's loopback grant runner, for run_granted_command. */
    grantRunner?: GrantRunnerEndpoint;
  },
): McpServerWire {
  if (!config.readonlyMcpCommand) {
    throw new ReadOnlyToolsUnavailableError(
      'agent tools unavailable: the Beeline MCP command is required',
    );
  }
  const connection = api.connection();
  return {
    name: BEELINE_AGENT_MCP_SERVER_NAME,
    command: config.readonlyMcpCommand,
    args: [...(config.readonlyMcpArgs ?? [])],
    env: [
      { name: 'BEELINE_MCP_SURFACE', value: 'agent' },
      ...(context.turnContextPath
        ? [{ name: 'BEELINE_TURN_CONTEXT_FILE', value: context.turnContextPath }]
        : []),
      ...(context.directMessage ? [{ name: 'BEELINE_AGENT_DM', value: '1' }] : []),
      { name: 'BEELINE_DAEMON_BASE_URL', value: connection.baseUrl },
      { name: 'BEELINE_DAEMON_TOKEN', value: connection.daemonToken },
      { name: 'BEELINE_HELPER_VERSION', value: connection.helperVersion },
      { name: 'BEELINE_DAEMON_AGENT_ID', value: connection.agentId },
      { name: 'BEELINE_DAEMON_ROOM_ID', value: context.roomId },
      { name: 'BEELINE_DAEMON_WORKSPACE_ID', value: context.workspaceId },
      ...(context.cornerId ? [{ name: 'BEELINE_DAEMON_CORNER_ID', value: context.cornerId }] : []),
      ...(context.agentMayCloseCorner
        ? [{ name: 'BEELINE_CORNER_AGENT_CLOSE', value: '1' }]
        : []),
      ...(context.agentMayUpgradeCorner
        ? [{ name: 'BEELINE_CORNER_CAN_UPGRADE', value: '1' }]
        : []),
      ...(context.reviewer ? [{ name: 'BEELINE_CORNER_REVIEWER', value: '1' }] : []),
      ...(context.cornerId && context.lane
        ? [{ name: 'BEELINE_CORNER_LANE', value: context.lane }]
        : []),
      ...(context.attachRoot ? [{ name: 'BEELINE_ATTACH_ROOT', value: context.attachRoot }] : []),
      ...(context.attachScratchRoot
        ? [{ name: 'BEELINE_ATTACH_SCRATCH_ROOT', value: context.attachScratchRoot }]
        : []),
      ...(context.grantRunner
        ? [
            { name: 'BEELINE_GRANT_RUNNER_URL', value: context.grantRunner.url },
            { name: 'BEELINE_GRANT_RUNNER_TOKEN', value: context.grantRunner.token },
          ]
        : []),
      // The host-shared Squire session registry the helper maintains, so
      // list_squire_sessions / close_squire_session work from the sandbox.
      {
        name: 'BEELINE_SQUIRE_SESSION_DIR',
        value: squireRegistryDir(config.operatorHome ?? homedir()),
      },
      ...(config.accessOwnerPubkey
        ? [{ name: 'BEELINE_AGENT_OWNER_ID', value: config.accessOwnerPubkey }]
        : []),
    ],
  };
}

/** The fixed Beeline-owned inspection surface mounted in monolith Room sessions. */
export function readOnlyMcpServer(
  config: BodyConfig,
  cwd: string,
  agentMemoryDir?: string,
): McpServerWire {
  if (!config.readonlyMcpCommand) {
    throw new ReadOnlyToolsUnavailableError(
      'read-only tools unavailable: beeline-readonly-mcp is required for Room sessions',
    );
  }
  // The one mapping, shared with the provisioner: a session can only be
  // pointed at the tree that activation actually materialized.
  const skillDir = agentSkillDir(config.agentKind);
  return {
    name: READ_ONLY_MCP_SERVER_NAME,
    command: config.readonlyMcpCommand,
    args: [...(config.readonlyMcpArgs ?? [])],
    env: [
      { name: 'BEELINE_READONLY_ROOT', value: resolve(cwd) },
      ...(config.agentHomeRoot
        ? [
            {
              name: 'BEELINE_READONLY_AGENT_SKILLS_ROOT',
              value: resolve(config.agentHomeRoot, skillDir, 'skills'),
            },
          ]
        : []),
      ...(agentMemoryDir
        ? [{ name: 'BEELINE_READONLY_AGENT_MEMORY_ROOT', value: resolve(agentMemoryDir) }]
        : []),
    ],
  };
}
