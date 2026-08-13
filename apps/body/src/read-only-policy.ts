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

const READ_ONLY_PERMISSION_TITLES = new Set(
  READ_ONLY_TOOL_NAMES.flatMap((tool) => [
    `mcp.${READ_ONLY_MCP_SERVER_NAME}.${tool}`,
    `${READ_ONLY_MCP_SERVER_NAME}.${tool}`,
    `${READ_ONLY_MCP_SERVER_NAME}/${tool}`,
  ]),
);
const READ_ONLY_TOOL_SET = new Set<string>(READ_ONLY_TOOL_NAMES);

/**
 * ACP classifies MCP calls as execute permissions. Auto-allow only the exact
 * tools on Body's fixed inspection server; the server remains responsible for
 * validating its bounded path/revision arguments.
 */
export function isReadOnlyMcpPermissionRequest(request: AcpPermissionRequest): boolean {
  const meta = request._meta;
  const isMcpApproval =
    Boolean(meta) &&
    typeof meta === 'object' &&
    !Array.isArray(meta) &&
    (meta as Record<string, unknown>).is_mcp_tool_approval === true;
  const title = request.toolCall?.title?.trim();
  const rawInput = request.toolCall?.rawInput;
  const mcpCall =
    Boolean(rawInput) && typeof rawInput === 'object' && !Array.isArray(rawInput)
      ? (rawInput as Record<string, unknown>)
      : undefined;
  return Boolean(
    isMcpApproval &&
    title &&
    READ_ONLY_PERMISSION_TITLES.has(title) &&
    mcpCall?.server === READ_ONLY_MCP_SERVER_NAME &&
    typeof mcpCall.tool === 'string' &&
    READ_ONLY_TOOL_SET.has(mcpCall.tool),
  );
}
