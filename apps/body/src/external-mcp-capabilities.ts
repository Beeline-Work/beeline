import { createHash } from 'node:crypto';
import type { PermissionScope } from '@beeline/buzz-client';
import type { AcpPermissionRequest, McpServerWire } from './acp.js';
import type { AgentAccessPolicy } from './access-policy.js';

/** External account capabilities that an operator may explicitly grant to one agent. */
export type ExternalMcpCapability = 'squire';

export const EXTERNAL_MCP_CAPABILITIES = ['squire'] as const;
export const SQUIRE_MCP_VERSION = '1.1.12';
export const SQUIRE_MCP_PACKAGE = `@trusty-squire/mcp@${SQUIRE_MCP_VERSION}`;

export function isTrustySquireMcpLaunch(
  command: string,
  args: readonly string[] = [],
): boolean {
  return [command, ...args].some((value) => {
    const normalized = value.trim().replace(/\\/g, '/').toLowerCase();
    return (
      /(^|[\s/="'\[,])@trusty-squire\/mcp(?:@[^\s/"'\],}]+)?(?=$|[\s/"'\],}])/i.test(
        normalized,
      ) ||
      /(^|\/)trusty-squire(?:-mcp)?(?:\.[a-z0-9]+)?$/i.test(normalized)
    );
  });
}

export function isExternalMcpCapability(value: unknown): value is ExternalMcpCapability {
  return (EXTERNAL_MCP_CAPABILITIES as readonly unknown[]).includes(value);
}

/**
 * Built-in profiles are intentionally code-owned rather than copied from the
 * operator's personal MCP config. That keeps the per-session inventory exact
 * and, importantly, never persists credentials in the runtime record.
 */
export function externalMcpServers(
  capabilities: readonly ExternalMcpCapability[] = [],
  squireBroker?: McpServerWire,
): McpServerWire[] {
  return capabilities.flatMap((capability) => {
    switch (capability) {
      case 'squire':
        return squireBroker ? [squireBroker] : [];
    }
  });
}

/** Account-backed tools are never mounted for a multi-member-drivable agent. */
export function authorizedExternalMcpServers(
  accessPolicy: AgentAccessPolicy | undefined,
  capabilities: readonly ExternalMcpCapability[] = [],
  squireBroker?: McpServerWire,
): McpServerWire[] {
  return accessPolicy === 'creator' ? externalMcpServers(capabilities, squireBroker) : [];
}

function shellPayload(toolCall: AcpPermissionRequest['toolCall']): boolean {
  const rawInput = toolCall?.rawInput;
  if (typeof rawInput === 'string') return true;
  if (!rawInput || typeof rawInput !== 'object' || Array.isArray(rawInput)) return false;
  const input = rawInput as Record<string, unknown>;
  return typeof input.command === 'string' || typeof input.cmd === 'string';
}

/**
 * Identify a call to an explicitly mounted external server across the ACP
 * spellings emitted by codex-acp and claude-agent-acp. Native shell payloads
 * are rejected before title matching so a command cannot spoof an MCP name.
 */
export function isExternalMcpPermissionRequest(
  request: AcpPermissionRequest,
  capabilities: readonly ExternalMcpCapability[] = [],
): boolean {
  const enabled = new Set<string>(capabilities);
  if (enabled.size === 0 || shellPayload(request.toolCall)) return false;
  const kind = request.toolCall?.kind;
  if (kind && kind !== 'other' && kind !== 'execute') return false;

  const rawInput = request.toolCall?.rawInput;
  if (rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)) {
    const server = (rawInput as Record<string, unknown>).server;
    if (typeof server === 'string' && enabled.has(server)) return true;
  }

  const title = request.toolCall?.title?.trim() ?? '';
  for (const server of enabled) {
    if (
      title.startsWith(`mcp.${server}.`) ||
      title.startsWith(`${server}.`) ||
      title.startsWith(`${server}/`) ||
      title.startsWith(`mcp__${server}__`)
    ) {
      return true;
    }
  }
  return false;
}

export type ExternalMcpPermissionPolicy = 'allow' | 'factory-permission' | 'deny';

/** Canonical MCP tool name across codex/Claude ACP spellings. */
export function externalMcpToolName(request: AcpPermissionRequest): string | undefined {
  if (shellPayload(request.toolCall)) return undefined;
  const rawInput = request.toolCall?.rawInput;
  if (rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)) {
    const input = rawInput as Record<string, unknown>;
    if (input.server === 'squire' && typeof input.tool === 'string') return input.tool;
  }
  const title = request.toolCall?.title?.trim() ?? '';
  const match =
    /^mcp__squire__([A-Za-z0-9_-]+)$/.exec(title) ??
    /^mcp\.squire\.([A-Za-z0-9_-]+)$/.exec(title) ??
    /^squire[./]([A-Za-z0-9_-]+)$/.exec(title);
  return match?.[1];
}

/** Metadata-only inventory needed to select and revoke an exact credential/grant. */
export const SQUIRE_READ_ONLY_TOOLS = new Set([
  'list_credentials',
  'list_app_access',
  'audit_log',
]);

/** Every side-effecting Squire verb Beeline exposes. All others fail closed. */
export const SQUIRE_GOVERNED_TOOLS = [
  'use_credential',
  'grant_app_access',
  'revoke_app_access',
] as const;
export type SquireGovernedTool = (typeof SQUIRE_GOVERNED_TOOLS)[number];
const SQUIRE_GOVERNED_TOOL_SET = new Set<string>(SQUIRE_GOVERNED_TOOLS);

/** Explicit profile policy: metadata reads or one exact P1-governed side effect. */
export function externalMcpPermissionPolicy(
  request: AcpPermissionRequest,
  capabilities: readonly ExternalMcpCapability[] = [],
): ExternalMcpPermissionPolicy {
  if (!isExternalMcpPermissionRequest(request, capabilities)) return 'deny';
  const tool = externalMcpToolName(request);
  if (!tool) return 'deny';
  if (SQUIRE_READ_ONLY_TOOLS.has(tool)) return 'allow';
  return SQUIRE_GOVERNED_TOOL_SET.has(tool) ? 'factory-permission' : 'deny';
}

type JsonObject = Record<string, unknown>;

export interface GovernedSquireCall {
  tool: SquireGovernedTool;
  arguments: JsonObject;
  scope: Extract<PermissionScope, { type: 'operation.execute' }>;
}

function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function nonEmptyString(value: unknown, maximum = 256): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized && normalized.length <= maximum ? normalized : undefined;
}

function credentialSelector(args: JsonObject): { label: string } | undefined {
  const reference = nonEmptyString(args.reference);
  const service = nonEmptyString(args.service);
  if (Boolean(reference) === Boolean(service)) return undefined;
  if (service) return { label: `service:${service}` };
  return { label: `reference:${digest(reference!).slice(0, 12)}` };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as JsonObject)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('Squire arguments must be JSON values');
  return encoded;
}

function digest(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

export function squireArgumentsDigest(value: unknown): string {
  return digest(value);
}

function exactArguments(request: AcpPermissionRequest): JsonObject | undefined {
  const raw = object(request.toolCall?.rawInput);
  if (!raw) return undefined;
  if (raw.server === 'squire' && typeof raw.tool === 'string') return object(raw.arguments);
  // claude-agent-acp identifies the MCP in the title and may forward the tool
  // arguments directly rather than wrapping them in {server, tool, arguments}.
  if (externalMcpToolName(request) && !('server' in raw) && !('tool' in raw)) return raw;
  return undefined;
}

function boundedTarget(value: string): string {
  return value
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .slice(0, 512);
}

/**
 * Convert one exact Squire call into P1's Tier-2 operation envelope. Sensitive
 * headers/body/query values never enter the relay event; only their canonical
 * SHA-256 digest does. Unknown or unbounded shapes are structurally refused.
 */
export function governedSquireCall(request: AcpPermissionRequest): GovernedSquireCall | undefined {
  const tool = externalMcpToolName(request);
  if (!tool || !SQUIRE_GOVERNED_TOOL_SET.has(tool)) return undefined;
  const args = exactArguments(request);
  if (!args) return undefined;
  let target: string;

  if (tool === 'use_credential') {
    const selector = credentialSelector(args);
    const http = object(args.http);
    const method = nonEmptyString(http?.method, 10)?.toUpperCase();
    const rawUrl = nonEmptyString(http?.url, 2_048);
    if (!selector || !method || !/^[A-Z]+$/.test(method) || !rawUrl) return undefined;
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return undefined;
    }
    if (url.protocol !== 'https:' || url.username || url.password) return undefined;
    target = `${method} ${url.origin}${url.pathname} via ${selector.label}`;
  } else if (tool === 'grant_app_access') {
    const selector = credentialSelector(args);
    const hourly = args.rate_limit_per_hour;
    const spend = args.spend_cap_usd;
    if (
      !selector ||
      !Number.isSafeInteger(hourly) ||
      (hourly as number) < 1 ||
      (hourly as number) > 100_000 ||
      (spend !== undefined && (typeof spend !== 'number' || !Number.isFinite(spend) || spend < 0))
    ) {
      return undefined;
    }
    target =
      `${selector.label}; max ${hourly} requests/hour` +
      (spend === undefined ? '' : `; spend cap USD ${spend}`);
  } else {
    const grantId = nonEmptyString(args.grant_id);
    if (!grantId) return undefined;
    target = `grant:${digest(grantId).slice(0, 12)}`;
  }

  return {
    tool: tool as SquireGovernedTool,
    arguments: args,
    scope: {
      type: 'operation.execute',
      connectorId: 'squire',
      tool,
      argumentsDigest: digest(args),
      target: boundedTarget(target),
      risk: 'out-of-scope',
    },
  };
}
