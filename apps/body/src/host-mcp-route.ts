/**
 * Host MCP routes: Beeline copies the route to a server into an agent's
 * isolated home, never the server. A granted host declaration is rewritten
 * (Squire gets the host rewrite env and the façade wrapper) and merged after
 * local servers are copied. Ungranted host servers stay out.
 */
import { stringify as stringifyToml } from 'smol-toml';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { isTrustySquireMcpLaunch } from './external-mcp-capabilities.js';
import {
  classifyImportedMcpServer,
  isCodeOwnedHostMcpName,
  MCP_ROUTE_CLASS_KEY,
} from './mcp-route-class.js';
import { squireFacadeLaunch, squireHostRewriteEnv } from './squire-host.js';

export function grantedMcpServerNames(
  grants: readonly { kind: string; target: string }[] | undefined,
): string[] {
  const names = new Set<string>();
  for (const grant of grants ?? []) {
    if (grant.kind !== 'mcp') continue;
    const name = grant.target.trim();
    if (name) names.add(name);
  }
  return [...names];
}

export function ungatedHostServers(
  hostServers: readonly string[],
  granted: readonly string[],
): string[] {
  const allowed = new Set(granted);
  return hostServers.filter((name) => !allowed.has(name));
}

export function grantedHostRoutesFromList(result: unknown): string[] {
  if (!result || typeof result !== 'object' || !('grants' in result)) return [];
  const grants = (result as { grants?: unknown }).grants;
  if (!Array.isArray(grants)) return [];
  return grantedMcpServerNames(
    grants.flatMap((entry) => {
      if (!entry || typeof entry !== 'object') return [];
      const row = entry as { kind?: unknown; target?: unknown };
      return typeof row.kind === 'string' && typeof row.target === 'string'
        ? [{ kind: row.kind, target: row.target }]
        : [];
    }),
  );
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
    ? (value as string[])
    : [];
}

function isSquireDeclaration(name: string, declaration: Record<string, unknown>): boolean {
  if (isCodeOwnedHostMcpName(name)) return true;
  const command =
    (typeof declaration.command === 'string' && declaration.command) ||
    (typeof declaration.cmd === 'string' && declaration.cmd) ||
    '';
  return Boolean(command) && isTrustySquireMcpLaunch(command, stringArray(declaration.args));
}

/**
 * Rewrite a host declaration into a route: keep a cheap stdio command, point a
 * singleton (Squire) at the host broker/profile, never copy the server itself.
 */
export function rewriteHostMcpDeclaration(
  name: string,
  declaration: Record<string, unknown>,
  hostHome: string,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...declaration };
  delete next[MCP_ROUTE_CLASS_KEY];
  if (!isSquireDeclaration(name, declaration)) return next;
  const launch = squireFacadeLaunch(hostHome);
  const gooseShape = 'cmd' in declaration && !('command' in declaration);
  if (gooseShape) {
    next.cmd = launch.command;
    next.args = launch.args;
    next.envs = { ...recordValue(declaration.envs), ...launch.env };
  } else {
    next.command = launch.command;
    next.args = launch.args;
    next.env = { ...recordValue(declaration.env), ...launch.env };
  }
  return next;
}

export function rewriteGrantedHostRoutes(
  declarations: Record<string, Record<string, unknown>>,
  granted: readonly string[],
  hostHome: string,
): Record<string, Record<string, unknown>> {
  const allowed = new Set(granted);
  const rewritten: Record<string, Record<string, unknown>> = {};
  for (const [name, declaration] of Object.entries(declarations)) {
    if (!allowed.has(name)) continue;
    if (classifyImportedMcpServer({ name, declaration }) !== 'host') continue;
    rewritten[name] = rewriteHostMcpDeclaration(name, declaration, hostHome);
  }
  return rewritten;
}

export function mergeTomlHostRoutes(
  existing: string | undefined,
  routes: Record<string, Record<string, unknown>>,
): string | undefined {
  if (Object.keys(routes).length === 0) return existing;
  const added = stringifyToml({ mcp_servers: routes });
  const chunk = added.endsWith('\n') ? added : `${added}\n`;
  if (!existing?.trim()) return chunk;
  const body = existing.endsWith('\n') ? existing : `${existing}\n`;
  return `${body}\n${chunk}`;
}

export function mergeJsonHostRoutes(
  existing: Record<string, unknown> | undefined,
  routes: Record<string, Record<string, unknown>>,
): Record<string, unknown> | undefined {
  if (Object.keys(routes).length === 0) return existing;
  return { ...(existing ?? {}), ...routes };
}

export function mergeGooseHostRoutes(existing: string | undefined, routes: Record<string, Record<string, unknown>>): string | undefined {
  if (Object.keys(routes).length === 0) return existing;
  let parsed: unknown = {};
  if (existing?.trim()) {
    try {
      parsed = parseYaml(existing);
    } catch {
      parsed = {};
    }
  }
  const document = recordValue(parsed) ?? {};
  const extensions = { ...recordValue(document.extensions), ...routes };
  return stringifyYaml({ ...document, extensions });
}

export function squireRouteEnv(hostHome: string): Record<string, string> {
  return squireHostRewriteEnv(hostHome);
}
