import type { AcpPermissionRequest } from './acp.js';

export const READ_ONLY_MCP_SERVER_NAME = 'beeline-readonly-mcp';
export const BEELINE_AGENT_MCP_SERVER_NAME = 'beeline-agent';
const READ_ONLY_MCP_TOOL_SERVER_NAME = READ_ONLY_MCP_SERVER_NAME.replaceAll('-', '_');

export const READ_ONLY_TOOL_NAMES = [
  'list_files',
  'read_file',
  'read_agent_file',
  'write_memory',
  'search_text',
  'git_log',
  'git_show',
  'git_diff',
  'git_status',
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
 * Separators an adapter puts between the server name and the tool name.
 * `__` is claude-agent-acp's (the Claude Agent SDK names every MCP tool
 * `mcp__<server>__<tool>` and normalizes punctuation in the server identifier
 * to underscores); the rest cover the dot/slash/space/paren spellings seen
 * elsewhere. A trailing `(<tool>)` form is checked separately, since it
 * brackets the name rather than prefixing it.
 */
const TOOL_NAME_SEPARATORS = ['__', '.', '/', ':', ' '] as const;
const READ_ONLY_SERVER_TITLE_PREFIXES = [
  `mcp__${READ_ONLY_MCP_SERVER_NAME}__`,
  `mcp__${READ_ONLY_MCP_TOOL_SERVER_NAME}__`,
  `mcp.${READ_ONLY_MCP_SERVER_NAME}.`,
  `${READ_ONLY_MCP_SERVER_NAME}/`,
  `${READ_ONLY_MCP_SERVER_NAME}:`,
  `${READ_ONLY_MCP_SERVER_NAME} `,
] as const;

/**
 * A shell payload, if this request carries one. A title is the only thing the
 * name-matching below has to go on, and a native shell tool's title IS its
 * command line — so a command whose text happens to end in an inspection tool
 * name (`rm -rf /tmp/beeline-readonly-mcp/read_file`) would otherwise satisfy
 * the suffix match and be auto-allowed straight through the Room read-only
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
 * Every MCP server this session mounted into a top-level Room. A harness that
 * names the tool but not the protocol (grok, below) can only be resolved
 * against this list, so it is the fail-closed floor: unknown server, no call.
 */
export const ROOM_MOUNTED_MCP_SERVERS = [
  READ_ONLY_MCP_SERVER_NAME,
  BEELINE_AGENT_MCP_SERVER_NAME,
] as const;

/**
 * How each harness spells one MCP tool call in a permission request. This is
 * the second harness-shaped surprise in this predicate, so the shapes are
 * written down rather than inferred — all four captured off the wire:
 *
 *   claude-agent-acp  title `mcp__<normalized_server>__<tool>`, kind `other`,
 *                     rawInput = the tool's OWN arguments. No MCP marker at
 *                     all (`fixtures/claude-agent-acp-permissions.ts`).
 *   codex-acp         title `mcp.<server>.<tool>`, rawInput
 *                     `{server, tool, arguments}`, `_meta.is_mcp_tool_approval`.
 *   pi-acp            never asks — pi executes before the daemon sees a call.
 *   grok              routes EVERY MCP call through its own `use_tool`
 *                     meta-dispatcher, so the request is titled `use_tool` and
 *                     carries `rawInput {tool_name: '<server>__<tool>',
 *                     tool_input: {…}}`; the following `tool_call_update`
 *                     relabels the title to that same qualified
 *                     `<server>__<tool>` and adds `variant: 'UseTool'`
 *                     (`fixtures/grok-use-tool-permissions.ts`). Nothing
 *                     anywhere in it says "mcp".
 *
 * The first two announce themselves as MCP calls and are taken at their word.
 * grok's does not, which is why it is resolved against the mounted-server
 * list instead of a name shape.
 */
const DISPATCHER_TOOL_NAME_KEYS = ['tool_name', 'toolName'] as const;
const DISPATCHER_TOOL_INPUT_KEYS = ['tool_input', 'toolInput'] as const;

/** A tool name is a bare identifier; anything with a space or a slash is not. */
const TOOL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

function permissionRecord(rawInput: unknown): Record<string, unknown> | undefined {
  return rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)
    ? (rawInput as Record<string, unknown>)
    : undefined;
}

/**
 * A wrapper envelope is not a hiding place. Unwrap the dispatched input first
 * and apply the same `shellPayload` test to it: a `use_tool` call whose
 * dispatched payload is itself a command line is refused exactly like a bare
 * shell request would be.
 */
function dispatchedPayloadIsShell(record: Record<string, unknown> | undefined): boolean {
  if (!record) return false;
  return DISPATCHER_TOOL_INPUT_KEYS.some(
    (key) => key in record && shellPayload({ rawInput: record[key] }),
  );
}

/** Every string in this request that could be naming the tool being called. */
function toolIdentityCandidates(toolCall: AcpPermissionRequest['toolCall']): string[] {
  const candidates: string[] = [];
  const add = (value: unknown): void => {
    if (typeof value === 'string' && value.trim()) candidates.push(value.trim());
  };
  add(toolCall?.title);
  const record = permissionRecord(toolCall?.rawInput);
  for (const key of DISPATCHER_TOOL_NAME_KEYS) add(record?.[key]);
  return candidates;
}

/** Server names differ only in punctuation between adapters (`-` vs `_`). */
function normalizedServerName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_');
}

/**
 * The mounted server and tool this request resolves to, or `undefined` when it
 * cannot be resolved to one. This is the identity the daemon already prints in
 * its journal (`beeline-agent__open_corner`) — the permission decision reads
 * the same fact instead of the harness's wrapper shape, so a call to a server
 * this session mounted is allowed whatever envelope it arrived in.
 */
export function resolveMountedMcpToolCall(
  request: AcpPermissionRequest,
  mountedServers: readonly string[],
): { server: string; tool: string } | undefined {
  const toolCall = request.toolCall;
  if (shellPayload(toolCall)) return undefined;
  const record = permissionRecord(toolCall?.rawInput);
  if (dispatchedPayloadIsShell(record)) return undefined;
  const candidates = toolIdentityCandidates(toolCall);
  for (const server of mountedServers) {
    const spellings = new Set([server.toLowerCase(), normalizedServerName(server)]);
    for (const candidate of candidates) {
      const lowered = candidate.toLowerCase();
      for (const spelling of spellings) {
        for (const separator of TOOL_NAME_SEPARATORS) {
          const prefix = `${spelling}${separator}`;
          if (!lowered.startsWith(prefix)) continue;
          const tool = candidate.slice(prefix.length).trim();
          if (TOOL_NAME_PATTERN.test(tool)) return { server, tool };
        }
      }
    }
  }
  return undefined;
}

/**
 * ACP classifies MCP calls as execute permissions. Allow a request only when it
 * names one of the exact tools on Body's fixed inspection server. Adapter-native
 * read/search tools are intentionally not trusted here: their path may name an
 * arbitrary host file, while this server validates daemon-pinned roots.
 * The original exact-envelope match required an is_mcp_tool_approval meta flag,
 * an exact title spelling, AND an exact rawInput server/tool pair all at once;
 * adapters that present any of those differently (observed live with
 * claude-agent-acp) fell through to the reject path and Rooms lost every read.
 * The server remains responsible for validating its bounded path/revision
 * arguments, so name-level identification is sufficient here.
 *
 * The separators matter and are not guesswork — see
 * `fixtures/claude-agent-acp-permissions.ts` for the verbatim captured
 * payloads. claude-agent-acp spells the tool
 * `mcp__<normalized_server>__<tool>` (an MCP call falls through its
 * `toolInfoFromToolUse` switch to the default branch, so it arrives as
 * `kind: 'other'` with no MCP envelope and nothing but that name); codex-acp
 * spells the same call `mcp.<server>.<tool>` and does forward the envelope. A
 * double-underscore form matches none of the dot/slash/space suffixes, which
 * is why the reported `read_file` / `git_log` / `git_show` calls were denied.
 */
export function isReadOnlyMcpPermissionRequest(request: AcpPermissionRequest): boolean {
  const toolCall = request.toolCall as
    (NonNullable<AcpPermissionRequest['toolCall']> & { kind?: unknown }) | undefined;
  const title = toolCall?.title?.trim() ?? '';
  const rawInput = toolCall?.rawInput;
  const mcpCall =
    Boolean(rawInput) && typeof rawInput === 'object' && !Array.isArray(rawInput)
      ? (rawInput as Record<string, unknown>)
      : undefined;
  // 1. The exact rawInput pair used by adapters that forward MCP envelopes.
  if (
    mcpCall?.server === READ_ONLY_MCP_SERVER_NAME &&
    typeof mcpCall.tool === 'string' &&
    READ_ONLY_TOOL_SET.has(mcpCall.tool)
  ) {
    return true;
  }
  // A shell command is never resolved by the name matching below.
  if (shellPayload(toolCall)) return false;
  // 2. Title spellings: the known exact forms, plus any title that both names
  // the inspection server and ends in one of its tool names (adapters differ in
  // separator/prefix; the tool-name suffix is the stable part).
  if (READ_ONLY_PERMISSION_TITLES.has(title)) return true;
  if (READ_ONLY_SERVER_TITLE_PREFIXES.some((prefix) => title.startsWith(prefix))) {
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
  return false;
}

/**
 * True when the request names a tool call on an MCP server this session
 * mounted, whatever adapter spelling it arrived in — see the harness table
 * above. A shell payload is never an MCP call (`shellPayload`), a dispatcher
 * envelope is unwrapped before that same test is applied, and unstructured
 * native tool requests (Read, Edit, …) fail every check and stay rejected.
 * Anything that cannot be positively resolved is refused.
 */
export function isMountedMcpToolPermissionRequest(
  request: AcpPermissionRequest,
  mountedServers: readonly string[] = ROOM_MOUNTED_MCP_SERVERS,
): boolean {
  const toolCall = request.toolCall as
    (NonNullable<AcpPermissionRequest['toolCall']> & { kind?: unknown }) | undefined;
  const rawInput = toolCall?.rawInput;
  // Unwrap a dispatcher envelope before anything else: a wrapper must not be
  // able to carry a command line past a rule that only reads the wrapper.
  if (dispatchedPayloadIsShell(permissionRecord(rawInput))) return false;
  if (rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)) {
    const call = rawInput as Record<string, unknown>;
    if (typeof call.server === 'string' && typeof call.tool === 'string') return true;
  }
  if (shellPayload(toolCall)) return false;
  const title = toolCall?.title?.trim() ?? '';
  if (/^mcp__[^_].*__[^_]/.test(title)) return true;
  if (/^mcp\.[^.]+\.[^.]/.test(title)) return true;
  // A harness that names the tool but never the protocol (grok's `use_tool`
  // envelope): the qualified name only resolves against what we mounted.
  if (resolveMountedMcpToolCall(request, mountedServers)) return true;
  // Older Beeline-only spellings that carried no `mcp.` prefix.
  return isReadOnlyMcpPermissionRequest(request) || isBeelineAgentMcpPermissionRequest(request);
}

const AGENT_SURFACE_TOOL_NAMES = ['open_corner', 'pr_checks_status', 'attach_file'] as const;

const SQUIRE_TITLE_PREFIXES = [
  'mcp__squire__',
  'mcp.squire.',
  'squire.',
  'squire/',
  // grok's qualified `<server>__<tool>` spelling, inside `use_tool` or as the
  // relabelled title.
  'squire__',
] as const;

/**
 * Trusty Squire stays host-broker-gated even where other MCP calls are
 * approved: it is never session-mounted in a thin Room. This wins before any
 * allow rule, and reads the dispatcher envelope as well as the title so a
 * wrapper cannot carry it past the gate.
 */
export function isSquireMcpPermissionRequest(request: AcpPermissionRequest): boolean {
  const rawInput = request.toolCall?.rawInput;
  if (rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)) {
    if ((rawInput as Record<string, unknown>).server === 'squire') return true;
  }
  return toolIdentityCandidates(request.toolCall).some((candidate) =>
    SQUIRE_TITLE_PREFIXES.some((prefix) => candidate.toLowerCase().startsWith(prefix)),
  );
}

/** The only host-governed mutations available directly from a thin Room. */
export function isBeelineAgentMcpPermissionRequest(request: AcpPermissionRequest): boolean {
  const toolCall = request.toolCall;
  const title = toolCall?.title?.trim() ?? '';
  const rawInput = toolCall?.rawInput;
  if (rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)) {
    const call = rawInput as Record<string, unknown>;
    if (
      call.server === BEELINE_AGENT_MCP_SERVER_NAME &&
      typeof call.tool === 'string' &&
      (AGENT_SURFACE_TOOL_NAMES as readonly string[]).includes(call.tool)
    ) {
      return true;
    }
  }
  if (shellPayload(toolCall)) return false;
  const normalized = BEELINE_AGENT_MCP_SERVER_NAME.replaceAll('-', '_');
  return AGENT_SURFACE_TOOL_NAMES.flatMap((tool) => [
    `mcp__${BEELINE_AGENT_MCP_SERVER_NAME}__${tool}`,
    `mcp__${normalized}__${tool}`,
    `mcp.${BEELINE_AGENT_MCP_SERVER_NAME}.${tool}`,
  ]).includes(title);
}
