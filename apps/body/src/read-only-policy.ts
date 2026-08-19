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
 * Separators an adapter puts between the server name and the tool name.
 * `__` is claude-agent-acp's (the Claude Agent SDK names every MCP tool
 * `mcp__<server>__<tool>`); the rest cover the dot/slash/space/paren spellings
 * seen elsewhere. A trailing `(<tool>)` form is checked separately, since it
 * brackets the name rather than prefixing it.
 */
const TOOL_NAME_SEPARATORS = ['__', '.', '/', ':', ' '] as const;

/**
 * A shell payload, if this request carries one. A title is the only thing the
 * name-matching below has to go on, and a native shell tool's title IS its
 * command line — so a command whose text happens to end in an inspection tool
 * name (`rm -rf /tmp/buzz-readonly-mcp/read_file`) would otherwise satisfy the
 * suffix match and be auto-allowed straight through the Room read-only
 * boundary. Identify a shell payload first and never name-match it.
 */
function shellPayload(toolCall: AcpPermissionRequest['toolCall']): boolean {
  const rawInput = toolCall?.rawInput;
  if (typeof rawInput === 'string') return true;
  if (!rawInput || typeof rawInput !== 'object' || Array.isArray(rawInput)) return false;
  const record = rawInput as Record<string, unknown>;
  return typeof record.command === 'string' || typeof record.cmd === 'string';
}

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
 *
 * The separators matter and are not guesswork — see
 * `fixtures/claude-agent-acp-permissions.ts` for the verbatim captured
 * payloads. claude-agent-acp spells the tool `mcp__<server>__<tool>` (an MCP
 * call falls through its `toolInfoFromToolUse` switch to the default branch, so
 * it arrives as `kind: 'other'` with no MCP envelope and nothing but that name);
 * codex-acp spells the same call `mcp.<server>.<tool>` and does forward the
 * envelope. A double-underscore form matches none of the dot/slash/space
 * suffixes, which is why the reported `read_file` / `git_log` / `git_show`
 * calls were still denied.
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
  // A shell command is never resolved by the name matching below.
  if (shellPayload(toolCall)) return false;
  // 3. Title spellings: the known exact forms, plus any title that both names
  // the inspection server and ends in one of its tool names (adapters differ in
  // separator/prefix; the tool-name suffix is the stable part).
  if (READ_ONLY_PERMISSION_TITLES.has(title)) return true;
  if (title.includes(READ_ONLY_MCP_SERVER_NAME)) {
    for (const tool of READ_ONLY_TOOL_NAMES) {
      if (
        title === tool ||
        title.endsWith(`(${tool})`) ||
        TOOL_NAME_SEPARATORS.some((separator) => title.endsWith(`${separator}${tool}`))
      ) {
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
