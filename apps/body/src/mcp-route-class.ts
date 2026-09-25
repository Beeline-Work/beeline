/**
 * Imported MCP servers are routes to the host, not replicas in the sandbox.
 *
 * Each declaration is `local` (copied into the isolated harness home as-is)
 * or `host` (kept out until an owner grant rewrites the route into the home).
 * Imported declarations are personal resources even when their process is local:
 * locality says nothing about credentials, connected accounts or ownership.
 * Repository tools supplied by the daemon are mounted separately.
 * The same classification applies to every imported server on every harness,
 * including Goose, and the Room permission matcher reads the same verdict.
 *
 * Grant acceptance (`host-mcp-route.ts`) writes the rewritten route; this
 * module is the import-step classifier alone.
 */

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

export function classifyImportedMcpServer(_input: ImportedMcpServerInput): McpRouteClass {
  return 'host';
}

/** An already configured broker route still carries Squire authority. */
export function hasSquireBrokerEnvironment(
  declaration: Record<string, unknown> | undefined,
): boolean {
  if (!declaration) return false;
  for (const key of ['env', 'envs']) {
    const env = declaration[key];
    if (!env || typeof env !== 'object' || Array.isArray(env)) continue;
    const socket = (env as Record<string, unknown>).TRUSTY_SQUIRE_BROKER_SOCKET;
    if (typeof socket === 'string' && socket.trim()) return true;
  }
  return false;
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
