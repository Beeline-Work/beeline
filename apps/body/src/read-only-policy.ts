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
 * Tool kinds the ACP adapters classify as pure inspection. `read` and `search`
 * never mutate; every mutating shape (`edit`, `delete`, `move`, `execute`, and
 * anything unknown) stays on the fail-closed path.
 */
const READ_ONLY_TOOL_KINDS = new Set(['read', 'search']);

/**
 * ACP classifies MCP calls as execute permissions. Allow a request only when it
 * is identifiable as pure inspection: the harness classified it as a read/search
 * kind, or it names one of the exact tools on Body's fixed inspection server.
 * The original exact-envelope match required an is_mcp_tool_approval meta flag,
 * an exact title spelling, AND an exact rawInput server/tool pair all at once;
 * adapters that present any of those differently (observed live with
 * claude-agent-acp) fell through to the reject path and Rooms lost every read.
 * The server remains responsible for validating its bounded path/revision
 * arguments, so name-level identification is sufficient here.
 */
export function isReadOnlyMcpPermissionRequest(request: AcpPermissionRequest): boolean {
  const toolCall = request.toolCall as
    | (NonNullable<AcpPermissionRequest['toolCall']> & { kind?: unknown })
    | undefined;
  // 1. The adapter's own classification: read/search kinds never mutate.
  const kind = typeof toolCall?.kind === 'string' ? toolCall.kind : undefined;
  if (kind && READ_ONLY_TOOL_KINDS.has(kind)) return true;

  const title = toolCall?.title?.trim() ?? '';
  const rawInput = toolCall?.rawInput;
  const mcpCall =
    Boolean(rawInput) && typeof rawInput === 'object' && !Array.isArray(rawInput)
      ? (rawInput as Record<string, unknown>)
      : undefined;
  // 2. The exact rawInput pair used by adapters that forward MCP envelopes.
  if (
    mcpCall?.server === READ_ONLY_MCP_SERVER_NAME &&
    typeof mcpCall.tool === 'string' &&
    READ_ONLY_TOOL_SET.has(mcpCall.tool)
  ) {
    return true;
  }
  // 3. Title spellings: the known exact forms, plus any title that both names
  // the inspection server and ends in one of its tool names (adapters differ in
  // separator/prefix; the tool-name suffix is the stable part).
  if (READ_ONLY_PERMISSION_TITLES.has(title)) return true;
  if (title.includes(READ_ONLY_MCP_SERVER_NAME)) {
    for (const tool of READ_ONLY_TOOL_NAMES) {
      if (title === tool || title.endsWith(`.${tool}`) || title.endsWith(`/${tool}`) || title.endsWith(` ${tool}`) || title.endsWith(`(${tool})`)) {
        return true;
      }
    }
  }
  // 4. A bare tool-name title with no server context: allow only if it is
  // exactly one of the six inspection tools (no other server may plausibly
  // collide with these names in a Body session).
  if (READ_ONLY_TOOL_SET.has(title)) return true;
  return false;
}
