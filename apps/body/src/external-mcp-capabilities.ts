import type { AcpPermissionRequest, McpServerWire } from './acp.js';
import type { AgentAccessPolicy } from './access-policy.js';

/** External account capabilities that an operator may explicitly grant to one agent. */
export type ExternalMcpCapability = 'squire';

export const EXTERNAL_MCP_CAPABILITIES = ['squire'] as const;

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
): McpServerWire[] {
  return capabilities.map((capability) => {
    switch (capability) {
      case 'squire':
        return {
          name: 'squire',
          command: 'npx',
          args: ['-y', '@trusty-squire/mcp'],
          env: [],
        };
    }
  });
}

/** Account-backed tools are never mounted for a multi-member-drivable agent. */
export function authorizedExternalMcpServers(
  accessPolicy: AgentAccessPolicy | undefined,
  capabilities: readonly ExternalMcpCapability[] = [],
): McpServerWire[] {
  return accessPolicy === 'creator' ? externalMcpServers(capabilities) : [];
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
  const enabled = new Set(externalMcpServers(capabilities).map((server) => server.name));
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

export type ExternalMcpPermissionPolicy = 'allow' | 'owner-confirm' | 'deny';

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

const SQUIRE_NON_SPENDING_TOOLS = new Set([
  'operate_start',
  'observe',
  'operate_observe',
  'act',
  'operate_act',
  'screenshot',
  'operate_screenshot',
  'extract',
  'operate_extract',
]);
const SQUIRE_SPENDING_TOOL = /(?:pay|payment|purchase|checkout|credential|card|wallet|spend)/i;

/** Shared-Room Squire policy: observation by default, owner ceremony for spend. */
export function externalMcpPermissionPolicy(
  request: AcpPermissionRequest,
  capabilities: readonly ExternalMcpCapability[] = [],
): ExternalMcpPermissionPolicy {
  if (!isExternalMcpPermissionRequest(request, capabilities)) return 'deny';
  const tool = externalMcpToolName(request);
  if (!tool) return 'deny';
  if (SQUIRE_NON_SPENDING_TOOLS.has(tool)) return 'allow';
  return SQUIRE_SPENDING_TOOL.test(tool) ? 'owner-confirm' : 'deny';
}
