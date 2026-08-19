/**
 * What each ACP harness actually enforces — confirmed by reading the installed
 * adapters, not assumed from the protocol.
 *
 * Beeline's Room read-only boundary and its corner worktree boundary are both
 * implemented in the ACP permission callback (`session-sandbox.ts`). That
 * callback only binds a harness that *asks*. Two adapters do; one does not:
 *
 *   - `codex-acp` (@agentclientprotocol/codex-acp): routes every command
 *     execution and file change through `session/request_permission`
 *     (`approvalPolicy: 'on-request'`) AND advertises a real `read-only`
 *     session mode backed by Codex's own OS sandbox
 *     (`sandboxPolicy: { type: 'readOnly' }`). Strongest: even a bypass of our
 *     callback still hits the sandbox. Beeline selects that mode for Rooms via
 *     `AcpClient.applySessionMode`.
 *   - `claude-agent-acp` (@agentclientprotocol/claude-agent-acp): routes every
 *     tool through the SDK's `canUseTool` -> `session/request_permission`. It
 *     advertises no read-only mode (its modes are `default`/`acceptEdits`/
 *     `plan`/`dontAsk`/`auto`), so a Room stays in `default`, which asks — our
 *     handler then denies. No OS sandbox; enforcement is the callback alone.
 *   - `pi-acp` (pi-acp, driving @earendil-works/pi-coding-agent): **never** calls
 *     `requestPermission` for a tool. Its only permission requests are pi's own
 *     extension-UI `select`/`confirm` events; read/write/edit/bash are emitted
 *     as `tool_call` telemetry *after* pi has already run them. pi's own docs
 *     state it has no built-in sandbox ("Real isolation needs to come from the
 *     operating system or a virtualization/container boundary") and it exposes
 *     no permission flag, env var, or setting the daemon could pass at spawn —
 *     `pi-acp` hard-codes `pi --mode rpc --no-themes`, and pi's `modes` over ACP
 *     are thinking levels, not permission modes. This is the confirmed bypass
 *     behind the observed breach: a Room session wrote to an absolute path
 *     outside its checkout without a single permission request reaching us.
 *
 * `goose` and `custom`/`reference` commands are unclassified and treated as
 * unenforced, because "we did not verify it" must not read as "it is safe".
 */

/** How much of the Room/corner boundary a harness can actually be held to. */
export type HarnessEnforcement =
  /** Asks for every mutation AND runs in its own OS sandbox when read-only. */
  | 'sandboxed'
  /** Asks for every mutation; the daemon's callback is the whole boundary. */
  | 'permission-callback'
  /** Never asks: the daemon cannot intercept its writes or shell commands. */
  | 'none'
  /** Not verified against a real adapter; treated as `none`. */
  | 'unknown';

interface HarnessProfile {
  enforcement: HarnessEnforcement;
  note: string;
}

const PROFILES: Array<{ match: RegExp; profile: HarnessProfile }> = [
  {
    match: /(^|[/\\])codex-acp(\.[a-z]+)?$/i,
    profile: {
      enforcement: 'sandboxed',
      note: 'codex-acp asks for every command/file change and enforces a read-only OS sandbox in read-only mode',
    },
  },
  {
    match: /(^|[/\\])claude-(agent|code)-acp(\.[a-z]+)?$/i,
    profile: {
      enforcement: 'permission-callback',
      note: 'claude-agent-acp asks for every tool call; it advertises no read-only mode, so the daemon callback is the only boundary',
    },
  },
  {
    match: /(^|[/\\])pi-acp(\.[a-z]+)?$/i,
    profile: {
      enforcement: 'none',
      note: 'pi-acp never sends session/request_permission for a tool call: pi executes reads, writes, edits, and shell commands before the daemon sees them, and exposes no sandbox or permission flag to pass at spawn',
    },
  },
  {
    match: /(^|[/\\])buzz-agent(\.[a-z]+)?$/i,
    profile: {
      enforcement: 'permission-callback',
      note: 'buzz-agent sends session/request_permission for mutating tools',
    },
  },
];

/**
 * Classify the configured ACP command. Unknown commands are `unknown`, which
 * callers must treat exactly like `none` — fail closed, never assume.
 */
export function harnessEnforcement(agentCommand: string | undefined): HarnessProfile {
  if (!agentCommand) return { enforcement: 'unknown', note: 'no ACP command configured' };
  for (const { match, profile } of PROFILES) {
    if (match.test(agentCommand)) return profile;
  }
  return {
    enforcement: 'unknown',
    note: `'${agentCommand}' has not been verified to send session/request_permission for mutating tools`,
  };
}

/** Can the daemon's permission callback actually hold this harness to a boundary? */
export function enforcesPermissionBoundary(agentCommand: string | undefined): boolean {
  const { enforcement } = harnessEnforcement(agentCommand);
  return enforcement === 'sandboxed' || enforcement === 'permission-callback';
}

/**
 * One-line operator line about how a Room's read-only rule is actually held for
 * this harness, or `undefined` when nothing needs saying.
 *
 * Two independent layers can hold it, and the line must not conflate them. The
 * ACP permission callback (`session-sandbox.ts`) binds only a harness that
 * asks; the OS sandbox (`bwrap-sandbox.ts`) binds every harness, including one
 * that never asks, because the filesystem it is handed is read-only. So a
 * harness the callback cannot hold is only ADVISORY while it is also unwrapped —
 * once the daemon wraps it, the boundary is real and the line says so instead
 * of warning about a gap that has been closed.
 */
export function roomSandboxWarning(
  agentCommand: string | undefined,
  options: { osSandbox?: boolean } = {},
): string | undefined {
  const { enforcement, note } = harnessEnforcement(agentCommand);
  if (enforcement === 'sandboxed' || enforcement === 'permission-callback') return undefined;
  if (options.osSandbox) {
    return (
      `Room read-only enforcement for this harness is the OS sandbox (sandbox=ON): ${note}. ` +
      `Its ACP child runs on a read-only filesystem, so a write is refused by the kernel ` +
      `rather than by a permission request the harness never sends.`
    );
  }
  return (
    `Room read-only enforcement is ADVISORY for this harness (sandbox=OFF): ${note}. ` +
    `The Room system prompt still forbids editing, but the daemon cannot block it. ` +
    `Use codex or claude for a Room that must be read-only, or install bubblewrap so the ` +
    `daemon can enforce it at the OS level.`
  );
}
