/**
 * Imported MCP servers are routes to the host, not replicas in the sandbox.
 *
 * Each declaration is `local` (copy as-is) or `host` (rewrite so the command
 * reaches the host's instance). Built-ins are code-owned: `squire` is `host`.
 * Everything else is `local` unless the operator marks it `host` with that
 * one key in their own config. Squire is the first code-owned host server
 * and the proof case; the same classification applies to every imported
 * server on every harness, including Goose.
 */
import { chmodSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { isTrustySquireMcpLaunch } from './external-mcp-capabilities.js';
import { extractTomlSections, tomlChildTableNames } from './toml-section.js';

export type McpRouteClass = 'local' | 'host';

/** Code-owned host servers. Operators mark others with `host = true`. */
export const CODE_OWNED_HOST_MCP_NAMES = ['squire'] as const;

export type McpRouteDeclaration = {
  name: string;
  command?: string;
  args?: readonly string[];
  /** Operator mark: JSON `"host": true`, TOML `host = true`, YAML `host: true`. */
  hostMark?: boolean;
  /** Raw table/block text, for launch-shape detection without a parsed argv. */
  sourceText?: string;
};

export function isCodeOwnedHostMcpName(name: string): boolean {
  return (CODE_OWNED_HOST_MCP_NAMES as readonly string[]).includes(name.trim().toLowerCase());
}

export function operatorHostMark(value: unknown): boolean {
  return value === true || value === 'true';
}

export function classifyMcpRoute(declaration: McpRouteDeclaration): McpRouteClass {
  if (declaration.hostMark) return 'host';
  if (isCodeOwnedHostMcpName(declaration.name)) return 'host';
  const command = declaration.command?.trim() ?? '';
  const args = declaration.args ?? [];
  if (command && isTrustySquireMcpLaunch(command, args)) return 'host';
  if (declaration.sourceText && isTrustySquireMcpLaunch(declaration.sourceText)) return 'host';
  return 'local';
}

/**
 * Host directory that must be the same inode in every agent's mount
 * namespace. Squire's default socket lives under `/tmp`, which is PrivateTmp
 * per unit and `--tmpfs /tmp` per ACP child — a path there is N brokers.
 */
export function squireHostDir(operatorHome: string): string {
  return resolve(operatorHome, '.trusty-squire');
}

export function squireHostBrokerSocket(operatorHome: string): string {
  return join(squireHostDir(operatorHome), 'broker.sock');
}

export function squireHostProfileDir(operatorHome: string): string {
  return resolve(squireHostDir(operatorHome), 'chrome-profile');
}

/**
 * `resolveBrokerSocket` only mkdir/0700-checks Squire's default `/tmp` path,
 * so the override directory must exist before any façade starts.
 */
export function ensureSquireHostBrokerDir(operatorHome: string): string {
  const dir = squireHostDir(operatorHome);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return dir;
}

/** Env that points a Squire façade at the host daemon, never a copied profile. */
export function squireHostRouteEnv(operatorHome: string): Record<string, string> {
  return {
    TRUSTY_SQUIRE_PROFILE_DIR: squireHostProfileDir(operatorHome),
    XDG_CONFIG_HOME: resolve(operatorHome, '.config'),
    TRUSTY_SQUIRE_BROKER_SOCKET: squireHostBrokerSocket(operatorHome),
  };
}

/**
 * Env that points a `host` declaration at the operator's instance.
 * Squire gets its three native variables; any other host server gets host
 * HOME / XDG_CONFIG_HOME, the env those servers already read.
 */
export function hostRouteEnv(
  declaration: McpRouteDeclaration,
  operatorHome: string,
): Record<string, string> {
  if (
    isCodeOwnedHostMcpName(declaration.name) ||
    (declaration.command && isTrustySquireMcpLaunch(declaration.command, declaration.args ?? [])) ||
    (declaration.sourceText && isTrustySquireMcpLaunch(declaration.sourceText))
  ) {
    return squireHostRouteEnv(operatorHome);
  }
  return {
    HOME: operatorHome,
    XDG_CONFIG_HOME: resolve(operatorHome, '.config'),
  };
}

export function defaultOperatorHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.HOME?.trim() || homedir();
}

/** Title/envelope spellings that name a host MCP server. */
export function hostMcpIdentityPrefixes(name: string): string[] {
  const lower = name.trim().toLowerCase();
  const underscored = lower.replace(/[^a-z0-9]+/g, '_');
  return [
    `mcp__${underscored}__`,
    `mcp.${lower}.`,
    `${lower}.`,
    `${lower}/`,
    `${underscored}__`,
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
    if (lowered === n) return true;
    return hostMcpIdentityPrefixes(n).some((prefix) => lowered.startsWith(prefix));
  });
}

function tomlBareKey(value: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value) ? value : JSON.stringify(value);
}

function mergeEnvLines(existing: string, env: Record<string, string>): string[] {
  return Object.entries(env)
    .filter(([key]) => !new RegExp(`^\\s*${key}\\s*=`, 'm').test(existing))
    .map(([key, value]) => `${key} = ${JSON.stringify(value)}`);
}

function rewriteTomlHostSection(name: string, section: string, env: Record<string, string>): string {
  const lines = mergeEnvLines(section, env);
  const trimmed = section.trimEnd();
  if (lines.length === 0) return `${trimmed}\n`;
  if (/\[mcp_servers\.[^\]]+\.env\]/.test(section)) {
    return `${trimmed}\n${lines.join('\n')}\n`;
  }
  return `${trimmed}\n\n[mcp_servers.${tomlBareKey(name)}.env]\n${lines.join('\n')}\n`;
}

function mcpRouteFromToml(name: string, section: string): McpRouteDeclaration {
  return {
    name,
    sourceText: section,
    hostMark: /^\s*host\s*=\s*true\s*$/m.test(section),
  };
}

/**
 * Codex/Grok `[mcp_servers.*]` import: local tables pass through; host tables
 * keep their command and gain the host route env. Nothing is dropped.
 */
export function importedHarnessMcpToml(source: string, operatorHome: string): string | undefined {
  const names = tomlChildTableNames(source, ['mcp_servers']);
  if (names.length === 0) return undefined;
  const parts: string[] = [];
  for (const name of names) {
    const section = extractTomlSections(source, ['mcp_servers', name]);
    if (!section) continue;
    const declaration = mcpRouteFromToml(name, section);
    if (classifyMcpRoute(declaration) === 'local') {
      parts.push(section.trimEnd());
      continue;
    }
    parts.push(
      rewriteTomlHostSection(name, section, hostRouteEnv(declaration, operatorHome)).trimEnd(),
    );
  }
  return parts.length > 0 ? `${parts.join('\n\n')}\n` : undefined;
}

function claudeArgs(server: Record<string, unknown>): string[] {
  return Array.isArray(server.args) && server.args.every((arg) => typeof arg === 'string')
    ? (server.args as string[])
    : [];
}

/**
 * Claude user-scope `mcpServers` import. Host entries keep command/args and
 * receive the host route env; local entries copy as-is.
 */
export function importedClaudeMcpServers(
  servers: Record<string, unknown>,
  operatorHome: string,
): Record<string, unknown> {
  const imported: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(servers)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      imported[name] = value;
      continue;
    }
    const server = value as Record<string, unknown>;
    const declaration: McpRouteDeclaration = {
      name,
      command: typeof server.command === 'string' ? server.command : undefined,
      args: claudeArgs(server),
      hostMark: operatorHostMark(server.host),
      sourceText: JSON.stringify(server),
    };
    if (classifyMcpRoute(declaration) === 'local') {
      imported[name] = server;
      continue;
    }
    const prior =
      server.env && typeof server.env === 'object' && !Array.isArray(server.env)
        ? { ...(server.env as Record<string, unknown>) }
        : {};
    imported[name] = {
      ...server,
      env: { ...prior, ...hostRouteEnv(declaration, operatorHome) },
    };
  }
  return imported;
}

type GooseExtension = { name: string; start: number; end: number; indent: number };

function gooseExtensionBlocks(source: string): GooseExtension[] {
  const lines = source.split('\n');
  const extensionsLine = lines.findIndex((line) => /^extensions:\s*(#.*)?$/.test(line));
  if (extensionsLine < 0) return [];
  const rootIndent = lines[extensionsLine]!.match(/^(\s*)/)?.[1]?.length ?? 0;
  const childIndent = rootIndent + 2;
  const blocks: GooseExtension[] = [];
  let current: GooseExtension | undefined;
  for (let index = extensionsLine + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.trim() === '' || /^\s*#/.test(line)) continue;
    const indent = line.match(/^(\s*)/)?.[1]?.length ?? 0;
    if (indent <= rootIndent) break;
    const header = indent === childIndent ? /^(\s*)([A-Za-z0-9_.-]+):\s*(#.*)?$/.exec(line) : null;
    if (header) {
      current = { name: header[2]!, start: index, end: lines.length, indent: childIndent };
      blocks.push(current);
    }
  }
  for (let i = 0; i < blocks.length - 1; i += 1) blocks[i]!.end = blocks[i + 1]!.start;
  return blocks;
}

function insertGooseHostEnv(block: string, indent: number, env: Record<string, string>): string {
  const missing = Object.entries(env).filter(
    ([key]) => !new RegExp(`^\\s*${key}\\s*:`, 'm').test(block),
  );
  if (missing.length === 0) return block;
  const envIndent = ' '.repeat(indent + 2);
  const valueIndent = ' '.repeat(indent + 4);
  const envLines = missing.map(([key, value]) => `${valueIndent}${key}: ${JSON.stringify(value)}`);
  if (/^\s*envs:\s*$/m.test(block)) {
    return block.replace(/^(\s*envs:\s*)$/m, `$1\n${envLines.join('\n')}`);
  }
  const injection = `${envIndent}envs:\n${envLines.join('\n')}`;
  const lines = block.split('\n');
  return [lines[0], injection, ...lines.slice(1)].join('\n');
}

/**
 * Goose `extensions:` import. A host extension keeps its command and gains
 * host route env; it is never copied raw. Local extensions pass through.
 */
export function importedGooseConfig(source: string, operatorHome: string): string {
  const lines = source.split('\n');
  const blocks = gooseExtensionBlocks(source);
  if (blocks.length === 0) return source;
  const replacements: Array<{ start: number; end: number; text: string }> = [];
  for (const block of blocks) {
    const text = lines.slice(block.start, block.end).join('\n');
    const declaration: McpRouteDeclaration = {
      name: block.name,
      hostMark: /^\s*host:\s*true\s*$/m.test(text),
      sourceText: text,
    };
    if (classifyMcpRoute(declaration) === 'local') continue;
    replacements.push({
      start: block.start,
      end: block.end,
      text: insertGooseHostEnv(text, block.indent, hostRouteEnv(declaration, operatorHome)),
    });
  }
  if (replacements.length === 0) return source;
  const out = [...lines];
  for (const replacement of [...replacements].reverse()) {
    out.splice(
      replacement.start,
      replacement.end - replacement.start,
      ...replacement.text.split('\n'),
    );
  }
  return out.join('\n');
}
