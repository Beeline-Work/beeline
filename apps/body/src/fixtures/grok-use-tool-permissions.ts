/**
 * Grok's MCP wire, captured VERBATIM from a live `grok agent stdio` (xAI Grok
 * CLI 1.0.13) session.
 *
 * Reproduce it by driving grok exactly the way `src/acp.ts` does —
 * `initialize`, then `session/new` mounting one stdio MCP server named
 * `beeline-agent` advertising `open_corner`, then a `session/prompt` asking for
 * that tool — and recording every `session/update` and
 * `session/request_permission` it sends. Only the `toolCallId` values are as
 * recorded; nothing else is edited.
 *
 * What they pin down: grok never issues an MCP call directly. Its model first
 * calls the native `search_tool` to fetch the schema, then dispatches through
 * the native `use_tool` meta-tool, so the call the daemon is asked to approve
 * is titled `use_tool` and names the real tool only inside the envelope, as the
 * QUALIFIED `<server>__<tool>` string grok's own docs call the tool name. The
 * `tool_call_update` that follows relabels the title to that same qualified
 * name and stamps `variant: 'UseTool'`. Nowhere in any of it does the token
 * `mcp` appear — which is why the title-shape tests in `read-only-policy.ts`
 * matched none of it and every Beeline tool was unusable from a Room on grok
 * (C90).
 */

/**
 * The frame grok emits as the call starts. A permission request is built from
 * this tool call, which is why the refusal the model reads back names
 * `use_tool` and not the tool it asked for.
 */
export const GROK_USE_TOOL_OPEN_CORNER_TOOL_CALL = {
  sessionUpdate: 'tool_call',
  toolCallId: 'call-429226ae-21fa-40f3-90e9-981bd34549f5-1',
  title: 'use_tool',
  rawInput: {
    tool_name: 'beeline-agent__open_corner',
    tool_input: { name: 'Fix it', objective: 'Fix the thing' },
  },
  _meta: {
    'x.ai/tool': {
      version: 1,
      name: 'use_tool',
      kind: 'use_tool',
      namespace: 'grok_build',
      label: 'Use Tool',
      read_only: false,
    },
  },
} as const;

/** The follow-up update: same call, now titled with the qualified tool name. */
export const GROK_USE_TOOL_OPEN_CORNER_TOOL_CALL_UPDATE = {
  sessionUpdate: 'tool_call_update',
  toolCallId: 'call-429226ae-21fa-40f3-90e9-981bd34549f5-1',
  kind: 'other',
  title: 'beeline-agent__open_corner',
  locations: [],
  rawInput: {
    variant: 'UseTool',
    tool_name: 'beeline-agent__open_corner',
    tool_input: { name: 'Fix it', objective: 'Fix the thing' },
  },
} as const;

/**
 * The permission request the daemon sees, assembled by `AcpClient` from the
 * `tool_call` frame above (`handlePermission` merges the tracked tool-call
 * metadata into the request). This is the exact payload that was refused on
 * release `692d8472`.
 */
export const GROK_USE_TOOL_OPEN_CORNER_PERMISSION = {
  sessionId: '01a06e65-a0ee-7e21-affe-9ab07b00772d',
  options: [
    { kind: 'reject_once', name: 'Deny', optionId: 'reject' },
    { kind: 'allow_once', name: 'Allow Once', optionId: 'allow' },
  ],
  toolCall: {
    toolCallId: 'call-429226ae-21fa-40f3-90e9-981bd34549f5-1',
    title: 'use_tool',
    rawInput: {
      tool_name: 'beeline-agent__open_corner',
      tool_input: { name: 'Fix it', objective: 'Fix the thing' },
    },
  },
} as const;

/**
 * grok's native tool-discovery call, for contrast: same session, same turn,
 * and not an MCP call at all. It must stay refused in a Room.
 */
export const GROK_NATIVE_SEARCH_TOOL_PERMISSION = {
  sessionId: '01a06e65-a0ee-7e21-affe-9ab07b00772d',
  options: [{ kind: 'reject_once', name: 'Deny', optionId: 'reject' }],
  toolCall: {
    toolCallId: 'call-4af4629e-53a0-4aea-927b-842136f575db-0',
    title: 'search_tool',
    rawInput: { query: 'beeline-agent open_corner', limit: 5 },
  },
} as const;
