/**
 * Imported MCP servers are routes to the host, not replicas in the sandbox.
 *
 * Each declaration is `local` (copied into the isolated harness home as-is)
 * or `host` (kept out of it, because reaching that server is the host's job).
 * Built-ins are code-owned: `squire` is `host`. Everything else is `local`
 * unless the operator marks it `host` with that one key in their own config.
 * The same classification applies to every imported server on every harness,
 * including Goose, and the Room permission matcher reads the same verdict.
 *
 * Routing a host server into a session — route acceptance, façade socket
 * wiring, the host-home broker inode — is a later lane; this module is the
 * import-step classifier alone.
 */
import { isTrustySquireMcpLaunch } from './external-mcp-capabilities.js';

export type McpRouteClass = 'local' | 'host';

/** Code-owned host servers. The name is the identity; launch matching is belt-and-suspenders. */
export const CODE_OWNED_HOST_MCP_NAMES = ['squire'] as const;

/**
 * The one operator key. Set `beeline_route = "host"` on a server in the
 * operator's own harness config to treat it as a host route.
 */
export const MCP_ROUTE_CLASS_KEY = 'beeline_route';
export const MCP_ROUTE_HOST = 'host';

export interface ImportedMcpServerInput {
  name: string;
  command?: string;
  args?: readonly string[];
  declaration?: Record<string, unknown>;
}

export function isCodeOwnedHostMcpName(name: string): boolean {
  return CODE_OWNED_HOST_MCP_NAMES.includes(name.trim().toLowerCase() as 'squire');
}

export function classifyImportedMcpServer(input: ImportedMcpServerInput): McpRouteClass {
  const name = input.name.trim();
  if (isCodeOwnedHostMcpName(name)) return 'host';
  const command = input.command ?? mcpLaunchCommand(input.declaration);
  const args = input.args ?? mcpLaunchArgs(input.declaration);
  if (command && isTrustySquireMcpLaunch(command, args)) return 'host';
  if (operatorMarkedHost(input.declaration)) return 'host';
  return 'local';
}

export function hostMcpIdentityPrefixes(name: string): string[] {
  const lower = name.trim().toLowerCase();
  const normalized = lower.replace(/[^a-z0-9]+/g, '_');
  return [
    `mcp__${lower}__`,
    `mcp__${normalized}__`,
    `mcp.${lower}.`,
    `${lower}.`,
    `${lower}/`,
    `${lower}__`,
  ];
}

export function isHostMcpIdentity(
  candidate: string,
  hostNames: readonly string[] = CODE_OWNED_HOST_MCP_NAMES,
): boolean {
  const lowered = candidate.trim().toLowerCase();
  if (!lowered) return false;
  return hostNames.some((name) => {
    const n = name.trim().toLowerCase();
    if (!n) return false;
    if (lowered === n) return true;
    return hostMcpIdentityPrefixes(n).some((prefix) => lowered.startsWith(prefix));
  });
}

function operatorMarkedHost(declaration: Record<string, unknown> | undefined): boolean {
  return declaration?.[MCP_ROUTE_CLASS_KEY] === MCP_ROUTE_HOST;
}

function mcpLaunchCommand(declaration: Record<string, unknown> | undefined): string | undefined {
  if (!declaration) return undefined;
  return stringField(declaration.command) ?? stringField(declaration.cmd);
}

function mcpLaunchArgs(declaration: Record<string, unknown> | undefined): string[] {
  return stringArray(declaration?.args);
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
    ? (value as string[])
    : [];
}
