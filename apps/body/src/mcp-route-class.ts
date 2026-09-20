/**
 * Imported MCP servers are routes to the host, not replicas in the sandbox.
 *
 * Each declaration is `local` (copy as-is) or `host` (rewrite so the command
 * reaches the host's instance). Built-ins are code-owned: `squire` is `host`.
 * Everything else is `local` unless the operator marks it `host` with that
 * one key in their own config. The same classification applies to every
 * imported server on every harness, including Goose.
 *
 * A host rewrite keeps the command and adds environment that points at the
 * host home. Route acceptance, façade socket wiring, and the host-home
 * broker inode are later lanes; this module is the import-step classifier.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
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

/** Durable mark written into a rewritten host declaration's env. */
export const MCP_ROUTE_CLASS_ENV_KEY = 'BEELINE_MCP_ROUTE';

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

export function rewriteHostMcpDeclaration(
  declaration: Record<string, unknown> | undefined,
  operatorHome: string,
  name: string,
): Record<string, unknown> {
  const rest = { ...(declaration ?? {}) };
  delete rest[MCP_ROUTE_CLASS_KEY];
  const envKey = mcpEnvKey(rest);
  const existing = mcpEnvRecord(rest);
  const nextEnv = {
    ...existing,
    ...hostRouteEnv(name, operatorHome, { ...rest, command: mcpLaunchCommand(rest) }),
  };
  const rewritten: Record<string, unknown> = { ...rest, [envKey]: nextEnv };
  if (envKey === 'envs') delete rewritten.env;
  else delete rewritten.envs;
  return rewritten;
}

export function hostRouteEnv(
  name: string,
  operatorHome: string,
  declaration?: Record<string, unknown>,
): Record<string, string> {
  const home = operatorHome || homedir();
  const env: Record<string, string> = {
    [MCP_ROUTE_CLASS_ENV_KEY]: MCP_ROUTE_HOST,
    HOME: home,
  };
  const command = mcpLaunchCommand(declaration);
  const args = mcpLaunchArgs(declaration);
  if (
    isCodeOwnedHostMcpName(name) ||
    (command !== undefined && isTrustySquireMcpLaunch(command, args))
  ) {
    env.TRUSTY_SQUIRE_PROFILE_DIR = join(home, '.trusty-squire', 'chrome-profile');
    env.XDG_CONFIG_HOME = join(home, '.config');
  }
  return env;
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
  if (!declaration) return false;
  if (declaration[MCP_ROUTE_CLASS_KEY] === MCP_ROUTE_HOST) return true;
  return mcpEnvRecord(declaration)[MCP_ROUTE_CLASS_ENV_KEY] === MCP_ROUTE_HOST;
}

function mcpLaunchCommand(declaration: Record<string, unknown> | undefined): string | undefined {
  if (!declaration) return undefined;
  return stringField(declaration.command) ?? stringField(declaration.cmd);
}

function mcpLaunchArgs(declaration: Record<string, unknown> | undefined): string[] {
  return stringArray(declaration?.args);
}

function mcpEnvKey(declaration: Record<string, unknown>): 'env' | 'envs' {
  if ('envs' in declaration) return 'envs';
  if ('env' in declaration) return 'env';
  if ('cmd' in declaration && !('command' in declaration)) return 'envs';
  return 'env';
}

function mcpEnvRecord(declaration: Record<string, unknown> | undefined): Record<string, string> {
  if (!declaration) return {};
  const raw = declaration.env ?? declaration.envs;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string') env[key] = value;
  }
  return env;
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
    ? (value as string[])
    : [];
}
