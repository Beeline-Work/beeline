/**
 * What tools an ACP session actually gets — and what the daemon must send so
 * that set is only ever Beeline's own.
 *
 * `harness-capabilities.ts` answers "can the daemon stop this harness from
 * *writing*". This module answers the separate question "can the daemon stop
 * this harness from handing Room members the OPERATOR's personal tools". They
 * are independent: the confirmed breach behind this module was a `claude`-backed
 * Room agent announcing the operator's claude.ai cloud connectors — "Figma,
 * Gmail, and Google Drive tools did come online", "Linear, Notion, Wolfram need
 * authorization" — which is a privacy hole no file sandbox touches, since any
 * Room member could then drive the operator's mailbox through the agent.
 *
 * Two distinct leak sources exist, and only one of them is a config file:
 *
 *   1. **Operator config files.** `~/.claude/settings.json` + `.claude.json`,
 *      project `.mcp.json`, plugins, `$CODEX_HOME/config.toml`'s
 *      `[mcp_servers.*]`. `agent-home.ts` already points a Room's
 *      `CLAUDE_CONFIG_DIR`/`CODEX_HOME` at a Beeline-owned directory, so these
 *      are out of reach for any Room that has its own agent home.
 *   2. **Account-bound cloud connectors.** claude.ai connectors (Claude Code)
 *      and `codex_apps` (Codex). These are fetched from the logged-in account,
 *      NOT from a config file, so relocating the config dir does nothing —
 *      `agent-home.ts` deliberately shares the operator's credentials back into
 *      the isolated dir, which is exactly what keeps the account (and its
 *      connectors) reachable. Only an explicit per-session opt-out closes them.
 *
 * Measured against the installed adapters (see the PR's running proof):
 *
 *   - `claude-agent-acp`: forwards `_meta.claudeCode.options` straight into the
 *     Claude Agent SDK's `query()` options. `strictMcpConfig` maps to the CLI's
 *     `--strict-mcp-config` ("only use MCP servers from --mcp-config, ignoring
 *     all other MCP configurations") and `settings` maps to `--settings`, which
 *     accepts a JSON string and is where `disableClaudeAiConnectors` lands.
 *     Both are sent: strict-mcp-config is the allowlist, and the setting is the
 *     belt for any CLI version that does not count an auto-fetched cloud
 *     connector as an "MCP configuration". Measured: 8 MCP servers / 90 tools
 *     before, 0 MCP servers / 26 built-in tools after.
 *   - `codex-acp`: has no session-level allowlist. It MERGES the client's
 *     requested servers into whatever `$CODEX_HOME/config.toml` already
 *     declares (`shouldDeduplicateMcpConflicts` drops a requested server whose
 *     name the config already uses), and its `CODEX_CONFIG` env override merges
 *     the same way — an empty `mcp_servers` table does not clear the config's.
 *     So the whole boundary is `CODEX_HOME`, i.e. whether this Room has its own
 *     agent home. `codex_apps` (the ChatGPT account's connected apps, 167 tools
 *     on the operator's account) survives even an isolated home; no config key
 *     or env var was found that turns it off.
 *   - `pi-acp`: accepts `mcpServers` on `session/new` and never reads the field
 *     again, so a pi Room does not even get Beeline's own read-only MCP; pi
 *     loads the operator's global `~/.pi/agent/extensions` and
 *     `~/.agents/skills` on its own. Nothing to pass, nothing to scope.
 *   - `buzz-agent`: Beeline's own agent. It has no operator-global MCP config
 *     of its own, so the mounted servers are the whole set by construction.
 */

/** How well the daemon can confine this harness's tool surface to its own. */
export type ToolScopeEnforcement =
  /** The session request itself pins the allowlist; operator config cannot widen it. */
  | 'allowlisted'
  /** No session-level allowlist: scope is only as good as the isolated harness home. */
  | 'config-isolated'
  /** The daemon cannot influence which tools this harness exposes. */
  | 'none'
  /** Not verified against a real adapter; treated as `none`. */
  | 'unknown';

/**
 * Settings Beeline forces on every Claude Code session, as a `--settings` JSON
 * string. `disableClaudeAiConnectors` is any-source-true, so an operator whose
 * own settings leave it false cannot re-widen a Beeline session.
 */
export const CLAUDE_TOOL_SCOPE_SETTINGS = { disableClaudeAiConnectors: true } as const;

/**
 * The one sentence every Beeline session's system prompt carries about its tool
 * surface. The observed breach was not only that the operator's connectors were
 * mounted — the agent also *advertised* them to the Room ("Figma, Gmail, and
 * Google Drive tools did come online", "Linear, Notion, Wolfram need
 * authorization via your claude.ai connector settings"), which invites a member
 * to drive the operator's personal accounts through it. Even with the mounts
 * gone, the model must never offer, claim, or try to authorize one.
 */
export const NO_PERSONAL_CONNECTORS_INSTRUCTION =
  'The only tools you have are the ones this host mounted for this session. ' +
  'Other than an explicitly host-mounted account tool, you have no personal, cloud, or ' +
  'account-linked connectors here — no email, drive, calendar, design, docs, or ticketing ' +
  'integrations — and no way to authorize one. Never claim any unmounted tool is available ' +
  'or coming online, never offer to connect one, and never tell anyone to change connector settings.';

interface ToolScopeProfile {
  enforcement: ToolScopeEnforcement;
  note: string;
  /** `_meta` merged into `session/new` for this harness. */
  sessionMeta?: Record<string, unknown>;
  /** Does this harness read the Beeline system prompt from `_meta.systemPrompt`? */
  metaSystemPrompt?: boolean;
}

const CLAUDE_PROFILE: ToolScopeProfile = {
  enforcement: 'allowlisted',
  note: 'claude-agent-acp forwards _meta.claudeCode.options to the Claude Agent SDK, so strictMcpConfig + disableClaudeAiConnectors pin the session to the mounted servers',
  sessionMeta: {
    claudeCode: {
      options: {
        // Only the servers passed on this session/new request. Drops project
        // .mcp.json, user settings, plugin, and agent-frontmatter MCP.
        strictMcpConfig: true,
        // Account-bound claude.ai cloud connectors are not fetched at all.
        settings: JSON.stringify(CLAUDE_TOOL_SCOPE_SETTINGS),
      },
    },
  },
  metaSystemPrompt: true,
};

const PROFILES: Array<{ match: RegExp; profile: ToolScopeProfile }> = [
  { match: /(^|[/\\])claude-(agent|code)-acp(\.[a-z]+)?$/i, profile: CLAUDE_PROFILE },
  {
    match: /(^|[/\\])codex-acp(\.[a-z]+)?$/i,
    profile: {
      enforcement: 'config-isolated',
      note: "codex-acp merges the session's MCP servers into $CODEX_HOME/config.toml's own [mcp_servers] instead of replacing them, so only an isolated CODEX_HOME scopes the session; the ChatGPT account's codex_apps connectors survive either way",
    },
  },
  {
    match: /(^|[/\\])pi-acp(\.[a-z]+)?$/i,
    profile: {
      enforcement: 'none',
      note: "pi-acp never reads the mcpServers it is handed, and pi loads the operator's global ~/.pi/agent/extensions and ~/.agents/skills itself",
    },
  },
  {
    match: /(^|[/\\])grok(\.[a-z]+)?$/i,
    profile: {
      enforcement: 'config-isolated',
      note: "grok loads the operator's own ~/.grok MCP servers even when session/new passes an empty mcpServers list (measured live), so only an isolated GROK_HOME scopes the session; no account-bound connector surface was found",
    },
  },
  {
    match: /(^|[/\\])buzz-agent(\.[a-z]+)?$/i,
    profile: {
      enforcement: 'allowlisted',
      note: 'buzz-agent mounts only the MCP servers the daemon passes; it has no operator-global tool config',
    },
  },
];

/** Classify the configured ACP command. Unknown commands fail closed. */
export function harnessToolScope(agentCommand: string | undefined): {
  enforcement: ToolScopeEnforcement;
  note: string;
} {
  const profile = matchProfile(agentCommand);
  if (profile) return { enforcement: profile.enforcement, note: profile.note };
  return {
    enforcement: 'unknown',
    note: agentCommand
      ? `'${agentCommand}' has not been verified to keep the operator's personal MCP servers and account connectors out of a session`
      : 'no ACP command configured',
  };
}

/**
 * The `_meta` that pins this harness's tool surface to the servers passed on
 * the same `session/new` request, or `undefined` when the harness has no such
 * lever. Sent unconditionally by `AcpClient.sessionNew` so no call site can
 * forget it.
 */
export function sessionToolScopeMeta(
  agentCommand: string | undefined,
): Record<string, unknown> | undefined {
  const meta = matchProfile(agentCommand)?.sessionMeta;
  // Structured-clone so a caller mutating the returned object cannot poison the
  // module-level profile for every later session.
  return meta ? (JSON.parse(JSON.stringify(meta)) as Record<string, unknown>) : undefined;
}

/**
 * Does this harness read Beeline's system prompt from `_meta.systemPrompt`?
 *
 * `claude-agent-acp` reads ONLY `_meta.systemPrompt` and ignores the top-level
 * `systemPrompt` field entirely, so a claude-backed Room used to run with none
 * of Beeline's instructions — including the read-only steer and the no-personal
 * -connectors rule this module exists to state. It is sent as `{ append }` so
 * the harness keeps its own `claude_code` preset underneath.
 */
export function harnessReadsMetaSystemPrompt(agentCommand: string | undefined): boolean {
  return matchProfile(agentCommand)?.metaSystemPrompt === true;
}

/**
 * One-line operator warning when a Room's tool surface is wider than Beeline's
 * own mounted servers, or `undefined` when it is not. `isolatedHarnessHome` is
 * whether this Room got its own `agent-home` (see `agent-home.ts`) — the only
 * thing standing between a codex session and `$HOME/.codex/config.toml`.
 */
export function toolScopeWarning(
  agentCommand: string | undefined,
  options: { isolatedHarnessHome: boolean },
): string | undefined {
  const { enforcement, note } = harnessToolScope(agentCommand);
  if (enforcement === 'allowlisted') return undefined;
  const parts = [
    `Room members can reach tools Beeline did not mount: ${note}.`,
    "Anything this harness exposes from the operator's own account or config is reachable by every Room member.",
  ];
  if (enforcement === 'config-isolated') {
    parts.push(
      options.isolatedHarnessHome
        ? "This Room has its own harness home, so the operator's config-file MCP servers are already out of reach."
        : 'Set BUZZY_BODY_ROOM_HOME=1 so this Room gets its own harness home.',
    );
  }
  return parts.join(' ');
}

function matchProfile(agentCommand: string | undefined): ToolScopeProfile | undefined {
  if (!agentCommand) return undefined;
  for (const { match, profile } of PROFILES) {
    if (match.test(agentCommand)) return profile;
  }
  return undefined;
}
