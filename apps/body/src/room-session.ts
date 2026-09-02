import { resolve } from 'node:path';
import type { McpServerWire } from './acp.js';
import type { BodyConfig } from './config.js';
import { READ_ONLY_MCP_SERVER_NAME } from './read-only-policy.js';

export class ReadOnlyToolsUnavailableError extends Error {
  override readonly name = 'ReadOnlyToolsUnavailableError';
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
        ? [{ name: 'BEELINE_READONLY_AGENT_SKILLS_ROOT', value: resolve(config.agentHomeRoot, skillDir, 'skills') }]
        : []),
      ...(agentMemoryDir
        ? [{ name: 'BEELINE_READONLY_AGENT_MEMORY_ROOT', value: resolve(agentMemoryDir) }]
        : []),
    ],
  };
}
