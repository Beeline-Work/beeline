/**
 * `session/request_permission` payloads captured VERBATIM from a real
 * `@agentclientprotocol/claude-agent-acp` (v0.66.0) process.
 *
 * Reproduce them with `scripts/capture-acp-permissions.mjs`, which drives the
 * adapter exactly the way `src/acp.ts` does — `initialize`, then `session/new`
 * mounting one MCP server named `buzz-readonly-mcp` (a stub advertising the
 * same six tool names as `read-only-policy.ts`), then `session/prompt` — and
 * records every `session/request_permission` it sends. Only `sessionId` /
 * `toolCallId` values are as recorded; nothing else is edited.
 *
 * What they pin down, and why guessing this wire shape kept going wrong:
 * claude-agent-acp carries NO MCP marker at all. An MCP tool falls through its
 * `toolInfoFromToolUse` switch to the default branch, so the request arrives
 * with the tool's fully-qualified name as `title`, a `kind` of `other`, and the
 * tool's own arguments as `rawInput` — no `_meta.is_mcp_tool_approval`, no
 * `rawInput.server`, no `rawInput.tool`. And the name is spelled
 * `mcp__<server>__<tool>`, not `mcp.<server>.<tool>`: a double underscore, which
 * matches none of the dot/slash/space suffix forms. Those are the two facts
 * that decided whether the reported `read_file` / `git_log` / `git_show` calls
 * were allowed, and both are recorded here rather than assumed.
 *
 * The native `Write` and `Bash` requests come from the same adapter, captured
 * the same way, and stay denied in a Room.
 */

/** `read_file` on Beeline's own inspection MCP, via claude-agent-acp. */
export const CLAUDE_ACP_MCP_READ_FILE_PERMISSION = {
  sessionId: '021881c9-d1a3-490b-8ff2-e4b752b34b6b',
  options: [
    { kind: 'reject_once', name: 'Deny', optionId: 'reject' },
    { kind: 'allow_once', name: 'Allow Once', optionId: 'allow' },
    { kind: 'allow_always', name: 'Always Allow', optionId: 'allow_always' },
  ],
  toolCall: {
    toolCallId: 'toolu_01X5rknhKdLzoRCzZWyjZ4Lm',
    rawInput: { path: 'README.md' },
    title: 'mcp__buzz-readonly-mcp__read_file',
    kind: 'other',
    content: [],
  },
} as const;

/** `git_show` on the same server: same shape again, third reported tool. */
export const CLAUDE_ACP_MCP_GIT_SHOW_PERMISSION = {
  sessionId: 'a2be0a2f-6d0b-4be3-9d64-6f1a24bd5f0c',
  options: [
    { kind: 'reject_once', name: 'Deny', optionId: 'reject' },
    { kind: 'allow_once', name: 'Allow Once', optionId: 'allow' },
    { kind: 'allow_always', name: 'Always Allow', optionId: 'allow_always' },
  ],
  toolCall: {
    toolCallId: 'toolu_01GL9JRhrFLz5pp4e6erhqg2',
    rawInput: { revision: 'HEAD' },
    title: 'mcp__buzz-readonly-mcp__git_show',
    kind: 'other',
    content: [],
  },
} as const;

/** `git_log` on the same server: same shape, different tool. */
export const CLAUDE_ACP_MCP_GIT_LOG_PERMISSION = {
  sessionId: '021881c9-d1a3-490b-8ff2-e4b752b34b6b',
  options: [
    { kind: 'reject_once', name: 'Deny', optionId: 'reject' },
    { kind: 'allow_once', name: 'Allow Once', optionId: 'allow' },
    { kind: 'allow_always', name: 'Always Allow', optionId: 'allow_always' },
  ],
  toolCall: {
    toolCallId: 'toolu_019JEBchtoeQGhGYnCj1SnCs',
    rawInput: { limit: 3 },
    title: 'mcp__buzz-readonly-mcp__git_log',
    kind: 'other',
    content: [],
  },
} as const;

/** claude-agent-acp's native `Write`, aimed outside the serving checkout. */
export const CLAUDE_ACP_NATIVE_WRITE_PERMISSION = {
  sessionId: 'c3c2e142-0fd5-431c-85a7-a59f430be72f',
  options: [
    { kind: 'reject_once', name: 'Deny', optionId: 'reject' },
    { kind: 'allow_once', name: 'Allow Once', optionId: 'allow' },
    { kind: 'allow_always', name: 'Always Allow', optionId: 'allow_always' },
  ],
  toolCall: {
    toolCallId: 'toolu_01Y43Qidh4ENpqqb6Pz358kR',
    rawInput: { file_path: '/tmp/beeline-probe.txt', content: 'hi' },
    title: 'Write /tmp/beeline-probe.txt',
    kind: 'edit',
    content: [
      { type: 'diff', path: '/tmp/beeline-probe.txt', oldText: null, newText: 'hi' },
    ],
    locations: [{ path: '/tmp/beeline-probe.txt' }],
  },
} as const;

/** claude-agent-acp's native `Bash`. */
export const CLAUDE_ACP_NATIVE_BASH_PERMISSION = {
  sessionId: 'c3c2e142-0fd5-431c-85a7-a59f430be72f',
  options: [
    { kind: 'reject_once', name: 'Deny', optionId: 'reject' },
    { kind: 'allow_once', name: 'Allow Once', optionId: 'allow' },
    { kind: 'allow_always', name: 'Always Allow', optionId: 'allow_always' },
  ],
  toolCall: {
    toolCallId: 'toolu_01QaBkb9cJ1Sj1cf6W7r9PRE',
    rawInput: { command: 'npm run typecheck', description: 'Run repository typecheck' },
    title: 'npm run typecheck',
    kind: 'execute',
    content: [
      { type: 'content', content: { type: 'text', text: 'Run repository typecheck' } },
    ],
  },
} as const;

/**
 * The adapter's own `Read`, as it appears in the `tool_call` update stream.
 * Captured from the same adapter: in `default` mode Claude Code auto-approves
 * its built-in `Read`, so it never reaches the host's permission callback —
 * but the `kind: 'read'` it declares is the same one a permission request
 * would carry under a stricter CLI permission config, which is why the Room
 * policy trusts an adapter-declared read kind.
 */
export const CLAUDE_ACP_NATIVE_READ_TOOL_CALL = {
  toolCallId: 'toolu_019tW72ndNqRijgT7umPctKw',
  rawInput: {},
  title: 'Read File',
  kind: 'read',
  locations: [],
} as const;

/**
 * codex-acp's shape for the identical MCP call, for contrast: it DOES mark the
 * approval and pass the server/tool as structured fields, and spells the tool
 * `mcp.<server>.<tool>` rather than `mcp__<server>__<tool>`.
 */
export const CODEX_ACP_MCP_READ_FILE_PERMISSION = {
  _meta: { is_mcp_tool_approval: true },
  toolCall: {
    kind: 'execute',
    title: 'mcp.buzz-readonly-mcp.read_file',
    rawInput: { server: 'buzz-readonly-mcp', tool: 'read_file', arguments: { path: 'README.md' } },
  },
} as const;
