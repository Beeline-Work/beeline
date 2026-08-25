import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { McpServerWire } from './acp.js';
import type { AgentAccessPolicy } from './access-policy.js';
import { isTrustySquireMcpLaunch } from './external-mcp-capabilities.js';

/**
 * Operator-configured MCP tool servers for corner edit sessions.
 *
 * Beeline's own inventory is fixed per surface (`buzz-readonly-mcp` for Rooms,
 * `buzz-dev-mcp` + codegraph for corners). Some work genuinely needs the
 * operator's own project-specific tool servers. This module is the "beeline
 * runtime config list" half of that: a JSON file inside the agent's runtime directory that
 * the OPERATOR authors by hand. It deliberately does NOT parse the harnesses'
 * own config locations:
 *
 *   - `pi` never reads the `mcpServers` it is handed over ACP anyway — it
 *     loads the operator's global `~/.pi/agent` extensions/skills itself, and
 *     Body deliberately never overrides `$HOME`, so operator-configured pi
 *     tools already reach every pi session through that path.
 *   - `codex-acp` merges session servers into an ISOLATED `CODEX_HOME`
 *     (`agent-home.ts`), so reading `~/.codex/config.toml` would couple Body
 *     to Codex's private config format for no benefit over one explicit list.
 *
 * The file lives at `<runtimeDir>/operator-mcp.json`:
 *
 * ```json
 * [{ "name": "project-tools", "command": "/opt/project-tools-mcp", "args": [] }]
 * ```
 *
 * Reading is best-effort and fail-open-to-empty: a missing or malformed file
 * never blocks a corner from opening. Trusty Squire names and launch aliases
 * are reserved for Beeline's separately governed host broker.
 */

/** Names Body mounts itself; an operator entry may not shadow them. */
const RESERVED_MCP_SERVER_NAMES = new Set([
  'buzz-readonly-mcp',
  'buzz-dev-mcp',
  'codegraph',
  'squire',
]);

export function readOperatorMcpServers(runtimeDir: string): McpServerWire[] {
  const path = resolve(runtimeDir, 'operator-mcp.json');
  if (!existsSync(path)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    console.warn(`[body] ignoring malformed ${path}:`, error);
    return [];
  }
  if (!Array.isArray(parsed)) {
    console.warn(`[body] ignoring ${path}: expected a JSON array of MCP server entries`);
    return [];
  }
  const servers: McpServerWire[] = [];
  const seen = new Set<string>();
  for (const entry of parsed) {
    const server = parseOperatorMcpEntry(entry, path);
    if (!server) continue;
    if (seen.has(server.name)) continue;
    seen.add(server.name);
    servers.push(server);
  }
  return servers;
}

function parseOperatorMcpEntry(entry: unknown, path: string): McpServerWire | undefined {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    console.warn(`[body] ignoring non-object MCP server entry in ${path}`);
    return undefined;
  }
  const { name, command, args, env } = entry as Record<string, unknown>;
  if (typeof name !== 'string' || !name.trim()) {
    console.warn(`[body] ignoring MCP server entry without a name in ${path}`);
    return undefined;
  }
  if (RESERVED_MCP_SERVER_NAMES.has(name)) {
    console.warn(
      `[body] ignoring MCP server entry "${name}" in ${path}: that name is reserved by Beeline`,
    );
    return undefined;
  }
  if (typeof command !== 'string' || !command.trim()) {
    console.warn(`[body] ignoring MCP server "${name}" in ${path}: missing command`);
    return undefined;
  }
  const normalizedArgs =
    Array.isArray(args) && args.every((a) => typeof a === 'string') ? (args as string[]) : [];
  if (isTrustySquireMcpLaunch(command, normalizedArgs)) {
    console.warn(
      `[body] ignoring MCP server "${name}" in ${path}: Trusty Squire is mounted only by Beeline`,
    );
    return undefined;
  }
  return {
    name,
    command,
    args: normalizedArgs,
    ...(Array.isArray(env) &&
    env.every(
      (pair) =>
        !!pair &&
        typeof pair === 'object' &&
        typeof (pair as Record<string, unknown>).name === 'string' &&
        typeof (pair as Record<string, unknown>).value === 'string',
    )
      ? { env: env as { name: string; value: string }[] }
      : { env: [] }),
  };
}

/**
 * Corner-session authorization for operator-configured servers.
 *
 * Same rule as account-backed capability profiles (`external-mcp-capabilities.ts`):
 * these tools act with the OPERATOR's authority, so they are mounted only when
 * the agent's access policy is `creator` (only the operator may drive it). An
 * `everyone` agent must never expose the operator's vaulted credentials or
 * connected accounts to whoever speaks in a Room. Names already mounted by
 * Beeline itself win; duplicates are dropped defensively even though
 * `readOperatorMcpServers` already filters reserved names.
 */
export function operatorMcpServersForCorners(
  accessPolicy: AgentAccessPolicy | undefined,
  configured: readonly McpServerWire[] = [],
): McpServerWire[] {
  if (accessPolicy !== 'creator') return [];
  return configured.filter(
    (server) =>
      !RESERVED_MCP_SERVER_NAMES.has(server.name) &&
      !isTrustySquireMcpLaunch(server.command, server.args),
  );
}
