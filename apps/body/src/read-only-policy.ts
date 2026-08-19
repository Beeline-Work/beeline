import type { AcpPermissionRequest } from './acp.js';

export const READ_ONLY_MCP_SERVER_NAME = 'buzz-readonly-mcp';

export const READ_ONLY_TOOL_NAMES = [
  'list_files',
  'read_file',
  'search_text',
  'git_log',
  'git_show',
  'git_diff',
] as const;

/**
 * Harness-authored titles for a call on this server. Separator style is
 * per-harness (codex flattens to `mcp.<server>.<tool>`, MCP's own convention
 * is `mcp__<server>__<tool>`), so all the known shapes are recognized rather
 * than assuming one.
 */
const READ_ONLY_PERMISSION_TITLES = new Set(
  READ_ONLY_TOOL_NAMES.flatMap((tool) => [
    `mcp.${READ_ONLY_MCP_SERVER_NAME}.${tool}`,
    `mcp__${READ_ONLY_MCP_SERVER_NAME}__${tool}`,
    `${READ_ONLY_MCP_SERVER_NAME}.${tool}`,
    `${READ_ONLY_MCP_SERVER_NAME}/${tool}`,
    `${READ_ONLY_MCP_SERVER_NAME}:${tool}`,
    `${READ_ONLY_MCP_SERVER_NAME} - ${tool}`,
  ]),
);
const READ_ONLY_TOOL_SET = new Set<string>(READ_ONLY_TOOL_NAMES);

/** `{server, tool, arguments}` is the MCP invocation envelope every harness echoes. */
function mcpEnvelope(rawInput: unknown): Record<string, unknown> | undefined {
  if (!rawInput || typeof rawInput !== 'object' || Array.isArray(rawInput)) return undefined;
  const envelope = rawInput as Record<string, unknown>;
  return typeof envelope.server === 'string' && typeof envelope.tool === 'string'
    ? envelope
    : undefined;
}

/** Codex marks an MCP approval on `_meta`; most other harnesses do not. */
function hostMarkedMcpApproval(request: AcpPermissionRequest): boolean {
  const meta = request._meta;
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return false;
  return (meta as Record<string, unknown>).is_mcp_tool_approval === true;
}

/**
 * ACP classifies MCP calls as execute permissions. Auto-allow only the exact
 * tools on Body's fixed inspection server; the server remains responsible for
 * validating its bounded path/revision arguments.
 *
 * Recognition must not hinge on a single harness's conventions. Requiring
 * codex's `_meta.is_mcp_tool_approval` marker *and* one exact title shape
 * meant every other harness's read-only lookups fell through to the mutating
 * classifier below it and were rejected in place — a Room agent that could see
 * its inspection tools but never use them. The envelope's own `server`/`tool`
 * pair is the harness-agnostic signal, and the marker+title pair stays as the
 * fallback for a harness that reports the call without one.
 *
 * Both paths still fail closed on the spoofing shape they exist to exclude: a
 * shell/exec invocation carries a `command` (never a `{server, tool}` pair),
 * and an envelope naming any other server or any tool outside this fixed list
 * is refused whatever its title claims.
 */
export function isReadOnlyMcpPermissionRequest(request: AcpPermissionRequest): boolean {
  const rawInput = request.toolCall?.rawInput;
  const envelope = mcpEnvelope(rawInput);
  if (envelope) {
    // A model cannot borrow this branch by naming a different server or a tool
    // that is not on the fixed inspection list.
    if (envelope.server !== READ_ONLY_MCP_SERVER_NAME) return false;
    if (!READ_ONLY_TOOL_SET.has(envelope.tool as string)) return false;
    // An envelope that also carries a shell payload is not an MCP call.
    return envelope.command === undefined;
  }
  const title = request.toolCall?.title?.trim();
  return Boolean(hostMarkedMcpApproval(request) && title && READ_ONLY_PERMISSION_TITLES.has(title));
}
