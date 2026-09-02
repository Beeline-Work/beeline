import { resolve } from 'node:path';
import type { McpServerWire } from './acp.js';
import type { BodyConfig } from './config.js';
import type { DaemonApiClient } from './daemon-api-client.js';
import { BEELINE_AGENT_MCP_SERVER_NAME, READ_ONLY_MCP_SERVER_NAME } from './read-only-policy.js';

export class ReadOnlyToolsUnavailableError extends Error {
  override readonly name = 'ReadOnlyToolsUnavailableError';
}

/** Daemon-backed corner controls mounted in Rooms and edit corners. */
export function beelineAgentMcpServer(
  config: BodyConfig,
  api: DaemonApiClient,
  context: { roomId: string; workspaceId: string; cornerId?: string; attachRoot?: string },
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
      { name: 'BEELINE_DAEMON_BASE_URL', value: connection.baseUrl },
      { name: 'BEELINE_DAEMON_TOKEN', value: connection.daemonToken },
      { name: 'BEELINE_DAEMON_AGENT_ID', value: connection.agentId },
      { name: 'BEELINE_DAEMON_ROOM_ID', value: context.roomId },
      { name: 'BEELINE_DAEMON_WORKSPACE_ID', value: context.workspaceId },
      ...(context.cornerId ? [{ name: 'BEELINE_DAEMON_CORNER_ID', value: context.cornerId }] : []),
      ...(context.attachRoot ? [{ name: 'BEELINE_ATTACH_ROOT', value: context.attachRoot }] : []),
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
  const skillDir =
    config.agentKind === 'claude' ||
    config.agentKind === 'codex' ||
    config.agentKind === 'grok' ||
    config.agentKind === 'pi'
      ? config.agentKind
      : 'codex';
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
