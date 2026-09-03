/**
 * What each ACP harness actually enforces — confirmed by reading the installed
 * adapters, not assumed from the protocol.
 *
 * Beeline's Room read-only callback and its corner hygiene-denylist callback
 * live in `session-sandbox.ts`. A corner also selects each adapter's no-prompt
 * autonomy mode; bubblewrap supplies the filesystem mount policy underneath.
 * The callback only binds a harness that *asks*. Two adapters do; one does not:
 *
 *   - `codex-acp` (@agentclientprotocol/codex-acp): routes every command
 *     execution and file change through `session/request_permission`
 *     (`approvalPolicy: 'on-request'`) AND advertises a real `read-only`
 *     session mode backed by Codex's own OS sandbox
 *     (`sandboxPolicy: { type: 'readOnly', networkAccess: false }`). That mode
 *     is offline as well as read-only, so Beeline selects it for a Room ONLY
 *     when the daemon's own OS sandbox is not wrapping the child. Under
 *     bubblewrap a Room selects `agent-full-access` exactly like a corner —
 *     Codex stops asking and has network — and the read-only filesystem rule
 *     is held by bwrap (checkout mounted read-only, private /tmp, harness
 *     state the only writable roots), which is how claude/pi Rooms are already
 *     held. See `roomModeCandidates`. Corners always select
 *     `agent-full-access` (`cornerAutonomyModeCandidates`).
 *   - `claude-agent-acp` (@agentclientprotocol/claude-agent-acp): routes every
 *     tool through the SDK's `canUseTool` -> `session/request_permission`. It
 *     advertises no read-only mode, so a Room stays in `default`, which asks —
 *     our handler then denies. Corners select its ACP `bypassPermissions` mode.
 *     No built-in OS sandbox; Room enforcement is the callback alone.
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
 *   - `grok` (xAI Grok CLI, native ACP over `grok agent stdio` — no adapter
 *     binary): sends standard `session/request_permission` requests for every
 *     mutating tool call in its default ask mode (verified live: an ACP client
 *     driving `grok agent stdio` received one for `kind: 'execute'` and the run
 *     resumed on the selected option). Like claude-agent-acp it advertises no
 *     ACP session modes at all (`session/new` returns no `modes`), so a Room's
 *     read-only rule is held by the daemon callback alone; corners drive through
 *     Body's auto-allow worktree callback, exactly like buzz-agent-backed
 *     corners. Two operator-side switches bypass the asking — `[ui]
 *     permission_mode = "always-approve"` in `~/.grok/config.toml` and
 *     `_meta.yoloMode` on `session/new` (which Beeline never sends) — so an
 *     operator who pinned always-approve has a Room boundary held only by the
 *     OS sandbox, same as a claude operator pinning bypassPermissions.
 *     `GROK_CONFIG` cannot change this either way: xAI deliberately excludes
 *     permission settings from that env overlay.
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
      note: 'codex-acp asks for every command/file change and enforces an offline read-only OS sandbox in read-only mode; under bubblewrap a Room runs it in agent-full-access and bwrap holds the filesystem rule',
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
    match: /(^|[/\\])grok(\.[a-z]+)?$/i,
    profile: {
      enforcement: 'permission-callback',
      note: 'grok sends standard session/request_permission requests for mutating tools in its default ask mode; it advertises no read-only ACP mode, so the daemon callback is the only boundary unless the OS sandbox wraps it',
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
 * Does this harness honor ACP `session/new`'s top-level `systemPrompt` field?
 *
 * Measured against the installed adapters, not assumed from the protocol:
 *  - `claude-agent-acp` ignores the top-level field but honors
 *    `_meta.systemPrompt`, which `AcpClient.sessionNew` sends for exactly this
 *    case (`harnessReadsMetaSystemPrompt`) — so its sessions DO carry the
 *    Beeline prompt.
 *  - `codex-acp` and `pi-acp` have no reference to `systemPrompt` anywhere in
 *    their distributions: both silently drop the entire Beeline session prompt
 *    (persona, read-only steer, attachment directive). This was the confirmed
 *    break behind agents still introducing themselves with the default
 *    identity while a soul overlay was published for them.
 *  - everything else (grok, buzz-agent, custom commands) is unverified.
 *
 * Callers use a `false` answer to ALSO deliver per-turn content that every
 * harness receives (turn prompts cannot be dropped by an adapter), so an
 * unverified harness must fail toward `false` — never assume delivery that
 * was not measured.
 */
export function harnessHonorsSessionSystemPrompt(agentCommand: string | undefined): boolean {
  return Boolean(
    agentCommand && /(^|[/\\])claude-(agent|code)-acp(\.[a-z]+)?$/i.test(agentCommand),
  );
}

/**
 * Can a new harness process reopen the same provider-owned conversation?
 *
 * This is deliberately narrower than the ACP capability bit. Codex and Grok
 * persist their logical conversation ids and implement `session/load`; their
 * session prompt/instruction semantics have been measured across a process
 * restart. Other adapters keep the conservative new-session + bounded
 * re-prime path even if a future version starts advertising the method.
 */
export function harnessSupportsNativeSessionResume(agentCommand: string | undefined): boolean {
  return Boolean(
    agentCommand &&
    (/(^|[/\\])codex-acp(\.[a-z]+)?$/i.test(agentCommand) ||
      /(^|[/\\])grok(\.[a-z]+)?$/i.test(agentCommand)),
  );
}

/**
 * Grok's cold ACP turn has a large fixed prefill, while a second prompt on the
 * same physical session reuses that prefix and streams in a few seconds. Keep
 * its process warm across an ordinary conversational pause. The scheduler's
 * hard Room/Workspace capacity still wins and may evict it immediately when a
 * slot is needed, so this changes idle cleanup rather than the memory bound.
 *
 * Measured with Grok CLI 1.0.5 on 2026-08-24: the same Beeline-shaped coding
 * prompt produced its first relay draft at 12.217s cold and 2.249s warm.
 */
export const GROK_WARM_SESSION_IDLE_MS = 30 * 60_000;

/** Per-harness override for the scheduler's ordinary idle retirement window. */
export function harnessSessionIdleMs(agentCommand: string | undefined): number | undefined {
  return agentCommand && /(^|[/\\])grok(\.[a-z]+)?$/i.test(agentCommand)
    ? GROK_WARM_SESSION_IDLE_MS
    : undefined;
}

/**
 * pi-acp is the one shipped harness that needs agent text for the target-branch
 * proposal command because it has no permission callback to carry that typed
 * command. Unknown/custom harnesses do not inherit this escape hatch.
 */
export function usesTextTargetBranchFallback(agentCommand: string | undefined): boolean {
  return Boolean(agentCommand && /(^|[/\\])pi-acp(\.[a-z]+)?$/i.test(agentCommand));
}

/**
 * ACP mode ids that make an EDIT corner non-interactive for each shipped
 * harness. The outer bubblewrap namespace remains the filesystem policy; these
 * switches only stop the adapter from asking before actions it can already take
 * inside that namespace.
 *
 * Codex calls this `agent-full-access`; claude-agent-acp exposes the Claude SDK
 * `bypassPermissions` mode through ACP. pi-acp has no permission mode because it
 * already executes tools without asking. Unknown adapters retain the portable
 * edit-mode candidates and Body's immediate allow/reject callback.
 */
export function cornerAutonomyModeCandidates(agentCommand: string | undefined): string[] {
  if (agentCommand && /(^|[/\\])codex-acp(\.[a-z]+)?$/i.test(agentCommand)) {
    return ['agent-full-access'];
  }
  if (agentCommand && /(^|[/\\])claude-(agent|code)-acp(\.[a-z]+)?$/i.test(agentCommand)) {
    return ['bypassPermissions'];
  }
  // grok advertises no ACP modes (`session/new` returns no `modes` field), so
  // there is nothing to select: corner mutations arrive as ordinary
  // `session/request_permission` requests and Body's auto-allow worktree
  // callback answers them, exactly like buzz-agent-backed corners.
  if (agentCommand && /(^|[/\\])grok(\.[a-z]+)?$/i.test(agentCommand)) return [];
  if (agentCommand && /(^|[/\\])pi-acp(\.[a-z]+)?$/i.test(agentCommand)) return [];
  return ['agent', 'edit', 'code'];
}

/**
 * ACP mode ids a top-level Room selects for each shipped harness.
 *
 * The portable answer is the harness's own read-only mode. Codex is the one
 * harness whose read-only mode also cuts the network
 * (`sandboxPolicy: { type: 'readOnly', networkAccess: false }`), so a Codex
 * Room agent under it cannot fetch a shared attachment or search the web while
 * claude/pi Room agents under bubblewrap can (`bwrap-sandbox.ts` shares the net
 * namespace). When the daemon's OS sandbox is ACTIVE for the session, a Codex
 * Room therefore selects `agent-full-access`, exactly as a corner does: the
 * checkout is mounted read-only by bwrap, so the filesystem rule is held by the
 * kernel rather than by Codex's mode, and the harness stops asking. Without
 * bwrap (missing, self-test failed, or `sandbox: off`) Codex keeps its own
 * offline read-only sandbox, because then nothing else holds the rule.
 */
export function roomModeCandidates(
  agentCommand: string | undefined,
  options: { osSandbox?: boolean } = {},
): string[] {
  if (options.osSandbox && agentCommand && /(^|[/\\])codex-acp(\.[a-z]+)?$/i.test(agentCommand)) {
    return ['agent-full-access'];
  }
  return ['read-only', 'readonly'];
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
  if (enforcement === 'sandboxed') {
    // codex-acp: the layer holding the rule depends on the OS sandbox, because
    // under bwrap the Room runs in agent-full-access (`roomModeCandidates`).
    return options.osSandbox
      ? `Room read-only enforcement for this harness is the OS sandbox (sandbox=ON): the ` +
          `session runs in Codex agent-full-access so it has network and never asks; the ` +
          `checkout is mounted read-only by bubblewrap, so a write is refused by the kernel.`
      : `Room read-only enforcement for this harness is Codex's own read-only mode ` +
          `(sandbox=OFF): the Room stays offline and read-only. Install bubblewrap so the ` +
          `daemon holds the filesystem rule and the Room can run in agent-full-access with network.`;
  }
  if (enforcement === 'permission-callback') return undefined;
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
    `Use claude for a Room that must be read-only (codex Rooms without bubblewrap stay ` +
    `offline-and-read-only in Codex's own sandbox), or install bubblewrap so the daemon ` +
    `can enforce it at the OS level.`
  );
}
