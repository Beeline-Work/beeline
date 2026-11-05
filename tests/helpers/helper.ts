import { mkdtempSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { isolatedNativeProof } from '../../apps/body/src/lifecycle-test-guard.js';

// Every test and every child it launches inherits private paths and an unreachable
// user bus. Native acceptance runs only in the separately supervised proof container.
if (!isolatedNativeProof(process.env)) {
  // /tmp disappears inside the Room's namespace; a long worktree path exceeds
  // Unix socket limits. /var/tmp gives tests a short, private, visible home.
  const home = mkdtempSync('/var/tmp/beeline-test-');
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = resolve(home, '.config');
  process.env.XDG_STATE_HOME = resolve(home, '.local/state');
  process.env.XDG_RUNTIME_DIR = resolve(home, 'run');
  for (const path of [
    process.env.XDG_CONFIG_HOME,
    process.env.XDG_STATE_HOME,
    process.env.XDG_RUNTIME_DIR,
  ])
    mkdirSync(path, { recursive: true });
  process.env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${home}/run/no-user-bus`;
  process.env.BEELINE_LIB_DIR = '';
  process.env.BEELINE_INSTALL_DIR = '';
  process.env.BEELINE_INSTALL_LIB_DIR = '';
}

/**
 * Headless login output as the real CLIs printed it on 2026-10-04 (ANSI
 * colour removed). Codes and challenges are from abandoned attempts.
 */

/** `codex login --device-auth`, Codex 0.160.0. */
export const CODEX_DEVICE_OUTPUT = `
Welcome to Codex [v0.160.0]
OpenAI's command-line coding agent

Follow these steps to sign in with ChatGPT using device code authorization:

1. Open this link in your browser and sign in to your account
   https://auth.openai.com/codex/device

2. Enter this one-time code (expires in 15 minutes)
   EBQ9-VJCLN

Continue only if you started this login in Codex. If a website or another person gave you this code, cancel.
`;

/** `grok login --device-auth`, Grok 1.0.46. */
export const GROK_DEVICE_OUTPUT = `
To sign in, open this URL in your browser:

  https://accounts.x.ai/oauth2/device?user_code=2RDF-2C74

  (Could not open browser automatically — open the URL above manually.)

Confirm this code in your browser:

  2RDF-2C74

Only continue with a code you requested. Don't share it with anyone.

Waiting for authorization...
`;

/** `NO_OPEN_BROWSER=1 cursor-agent login`, Cursor Agent 2026.10.01-e373342. */
export const CURSOR_LOGIN_OUTPUT = `Starting login process...
Authenticating with Cursor...
Waiting for browser authentication...
Open a browser and navigate to this link: https://cursor.com/loginDeepControl?challenge=INZtIO70adwqYFOZA047ajbYLE7XW3K6ceG4IkULyLE&uuid=f2174507-b113-463b-a584-e3ffb20853d9&mode=login&redirectTarget=cli&supportsSelectedTeamLogin=true
`;

/**
 * `quota-axi --provider codex,cursor,claude --json --no-credential-refresh`
 * (quota-axi 0.1.64), run on squire on 2026-10-20 with a Beeline agent's own
 * CODEX_HOME, CLAUDE_CONFIG_DIR and XDG_CONFIG_HOME, split by provider. Each
 * provider's `quotaSemantics` block is trimmed; nothing else is edited.
 */
export const QUOTA_AXI_CODEX_CURSOR_REPORT = {
  "generatedAt": "2026-10-20T02:22:23.939Z",
  "schemaVersion": 5,
  "providers": [
    {
      "provider": "codex",
      "plan": "pro",
      "windows": [
        {
          "id": "weekly",
          "label": "week",
          "kind": "weekly",
          "resetsAt": "2026-10-24T20:43:11.000Z",
          "percentRemaining": 53,
          "pace": {
            "status": "ahead",
            "reservePercentPoints": -15.0633,
            "burnMultiple": 1.4717
          }
        }
      ],
      "credits": {
        "remaining": 62174.920478,
        "unlimited": false,
        "unit": "credits"
      },
      "state": {
        "status": "fresh",
        "stale": false
      },
      "accountKeys": [
        "codex-home"
      ]
    },
    {
      "provider": "cursor",
      "plan": "Ultra",
      "windows": [
        {
          "id": "included_usage",
          "label": "included usage",
          "kind": "monthly",
          "resetsAt": "2026-11-19T13:27:39.000Z",
          "percentRemaining": 100,
          "pace": {
            "status": "behind",
            "reservePercentPoints": 1.7355,
            "burnMultiple": 0
          }
        },
        {
          "id": "auto_usage",
          "label": "auto usage",
          "kind": "monthly",
          "resetsAt": "2026-11-19T13:27:39.000Z",
          "percentRemaining": 100,
          "pace": {
            "status": "behind",
            "reservePercentPoints": 1.7355,
            "burnMultiple": 0
          }
        },
        {
          "id": "api_usage",
          "label": "API usage",
          "kind": "monthly",
          "resetsAt": "2026-11-19T13:27:39.000Z",
          "percentRemaining": 100,
          "pace": {
            "status": "behind",
            "reservePercentPoints": 1.7355,
            "burnMultiple": 0
          }
        },
        {
          "id": "grok_bot",
          "label": "Grok Bot",
          "kind": "weekly",
          "resetsAt": "2026-10-24T13:27:45.964Z",
          "percentRemaining": 100,
          "pace": {
            "status": "behind",
            "reservePercentPoints": 36.2563,
            "burnMultiple": 0
          }
        }
      ],
      "state": {
        "status": "fresh",
        "stale": false
      },
      "accountKeys": [
        "default"
      ]
    }
  ]
} as const;

/** The Claude provider from the same run. */
export const QUOTA_AXI_CLAUDE_REPORT = {
  "generatedAt": "2026-10-20T02:22:23.939Z",
  "schemaVersion": 5,
  "providers": [
    {
      "provider": "claude",
      "plan": "max",
      "windows": [
        {
          "id": "five_hour",
          "label": "session",
          "kind": "session",
          "resetsAt": "2026-10-20T05:00:00.017148+00:00",
          "percentRemaining": 91,
          "pace": {
            "status": "behind",
            "reservePercentPoints": 38.4662,
            "burnMultiple": 0.1896
          }
        },
        {
          "id": "seven_day",
          "label": "week",
          "kind": "weekly",
          "resetsAt": "2026-10-23T05:00:00.017167+00:00",
          "percentRemaining": 72,
          "pace": {
            "status": "behind",
            "reservePercentPoints": 27.5794,
            "burnMultiple": 0.5038
          }
        },
        {
          "id": "model:fable",
          "label": "Fable week",
          "kind": "model",
          "resetsAt": "2026-10-23T05:00:00.017344+00:00",
          "percentRemaining": 100,
          "pace": {
            "status": "behind",
            "reservePercentPoints": 55.5794,
            "burnMultiple": 0
          }
        }
      ],
      "state": {
        "status": "fresh",
        "stale": false
      },
      "accountKeys": [
        "default"
      ]
    }
  ]
} as const;

/**
 * `session/request_permission` payloads captured VERBATIM from a real
 * `@agentclientprotocol/claude-agent-acp` (v0.66.0) process.
 *
 * Reproduce them with `scripts/capture-acp-permissions.mjs`, which drives the
 * adapter exactly the way `src/acp.ts` does — `initialize`, then `session/new`
 * mounting one MCP server named `beeline-readonly-mcp` (a stub advertising the
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
 * `mcp__<normalized_server>__<tool>`, not `mcp.<server>.<tool>`: punctuation in
 * the server name and the separators are underscores. Those are the two facts
 * that decided whether the reported `read_file` / `git_log` / `git_show` calls
 * were allowed, and both are recorded here rather than assumed.
 *
 * The native `Write` and `Bash` requests come from the same adapter, captured
 * the same way. A Room still denies Write; it allows Bash only while the OS
 * sandbox that holds the Room's read-only filesystem wraps the session. `Bash`
 * declares `kind: 'execute'`, which is the whole of what that decision reads.
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
    title: 'mcp__beeline_readonly_mcp__read_file',
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
    title: 'mcp__beeline_readonly_mcp__git_show',
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
    title: 'mcp__beeline_readonly_mcp__git_log',
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
    content: [{ type: 'diff', path: '/tmp/beeline-probe.txt', oldText: null, newText: 'hi' }],
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
    content: [{ type: 'content', content: { type: 'text', text: 'Run repository typecheck' } }],
  },
} as const;

/**
 * The adapter's own `Read`, as it appears in the `tool_call` update stream.
 * Captured from the same adapter: in `default` mode Claude Code auto-approves
 * its built-in `Read`, so it never reaches the host's permission callback —
 * but the `kind: 'read'` it declares is the same one a permission request
 * would carry under a stricter CLI permission config, which is why the Room
 * policy additionally requires paths confined to the agent’s attachment tree.
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
    title: 'mcp.beeline-readonly-mcp.read_file',
    rawInput: {
      server: 'beeline-readonly-mcp',
      tool: 'read_file',
      arguments: { path: 'README.md' },
    },
  },
} as const;
