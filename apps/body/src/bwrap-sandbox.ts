/**
 * OS-level sandbox for ACP harness child processes (bubblewrap).
 *
 * `session-sandbox.ts` is the *policy* boundary — a Room denies every mutating
 * ACP request, a corner denies one whose target escapes its worktree. That
 * boundary binds only a harness that actually calls `session/request_permission`,
 * and `harness-capabilities.ts` records that one shipped adapter (`pi-acp`)
 * never does: pi executes reads, writes, edits and shell commands *before* the
 * daemon sees them. For that harness the Room read-only rule is advisory text in
 * a system prompt and nothing more.
 *
 * This module adds the layer underneath: when `bwrap` is available, the harness
 * is spawned into a mount namespace where the writes the policy would have
 * denied are not merely refused — they are impossible, because the filesystem
 * the child sees is read-only everywhere except the small set of paths that
 * session legitimately owns.
 *
 * ## Mount table
 *
 * Every session starts from the same base:
 *
 * ```
 *   --ro-bind / /        the whole host filesystem, read-only. This is what
 *                        makes the canonical checkout, the operator's own
 *                        checkout, and $HOME read-only without having to
 *                        enumerate any of them.
 *   --dev /dev           a minimal private /dev (the ro-bind above would
 *                        otherwise hand the child a read-only /dev/null).
 *   --proc /proc         a private /proc for the new namespace.
 *   --tmpfs /tmp         a private, writable, discarded-at-exit /tmp.
 * ```
 *
 * **Both modes** then get read-write binds for the harness's own state
 * directories: the `CLAUDE_CONFIG_DIR`/`CODEX_HOME`/`XDG_*`/`TMPDIR` overlay
 * from `agent-home.ts`, plus {@link harnessHomeStateDirs} for the state roots no
 * env var relocates. **A Room having writable harness state is a deliberate,
 * measured departure from "a Room writes nothing but /tmp", and it is not
 * optional**: with those directories read-only, `codex-acp` cannot start a Room
 * session at all (`failed to initialize sqlite state runtime under …/codex`) and
 * `pi-acp` cannot start one in either mode (`EROFS … open
 * '~/.pi/pi-acp/session-map.json'`). A sandbox that bricks two of the three
 * shipped harnesses is strictly worse than the gap it closes. Harness state is
 * neither the repository nor the operator's tree, so the property that actually
 * matters is untouched: a Room still cannot write one byte of any checkout, or
 * anywhere else on the host.
 *
 * **Corner (`edit`)** adds, on top of that, the two things an edit session owns:
 * its own worktree, and the repository's **git common directory**. That second
 * one is required, not incidental — a corner worktree is a *linked* `git
 * worktree`, so its refs, index and newly written objects all live under the
 * canonical checkout's `.git`. Without it a corner could edit files but never
 * commit. The canonical checkout's *working tree* stays read-only in both modes.
 *
 * Network is deliberately untouched (no `--unshare-net`): every harness needs to
 * reach its model API.
 *
 * ## Fail-open, loudly
 *
 * `bwrap` missing, or present but unable to create a namespace on this host (a
 * container without the right capabilities, unprivileged user namespaces
 * disabled, a hardened kernel), must not stop the daemon from serving Rooms —
 * that would turn a hardening feature into an outage. `detectBwrapSandbox`
 * self-tests once at daemon start and the caller logs exactly one advisory line;
 * every spawn afterwards is unwrapped, i.e. today's behaviour, with
 * `session-sandbox.ts` still the boundary it always was.
 */
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';
import { executableOnPath } from './agent-command.js';
import type { SessionMode } from './config.js';

/** Operator switch, persisted on the runtime record and mirrored onto BodyConfig. */
export type SandboxPolicy = 'bwrap' | 'off';

export const DEFAULT_SANDBOX_POLICY: SandboxPolicy = 'bwrap';

export function isSandboxPolicy(value: unknown): value is SandboxPolicy {
  return value === 'bwrap' || value === 'off';
}

/**
 * Harness state roots under the operator's `$HOME` that no env var relocates,
 * so `agent-home.ts` cannot point them at a per-Room path and the sandbox has to
 * name them explicitly.
 *
 * Keyed on the ACP command, the same way `harness-capabilities.ts` keys its
 * per-adapter facts, so a host running one harness never has empty state
 * directories for four others created in its home. Adding a harness preset means
 * checking whether it needs an entry: the symptom of a missing one is an `EROFS`
 * or "failed to initialize state" error out of `session/new`, not a permission
 * denial, because this is the harness's own bookkeeping rather than a tool call.
 */
export const HARNESS_HOME_STATE_DIRS: Array<{ match: RegExp; dirs: string[] }> = [
  {
    // pi writes ~/.pi/pi-acp/session-map.json on every session/new. pi-acp
    // hard-codes that path — no flag, env var or setting moves it, which is also
    // why `agent-home.ts` has no overlay entry for pi.
    match: /(^|[/\\])pi(-acp)?(\.[a-z]+)?$/i,
    dirs: ['.pi'],
  },
  {
    // Only load-bearing for a Room still on the daemon's ambient harness state
    // (no per-room agent home): there CLAUDE_CONFIG_DIR/CODEX_HOME are absent
    // from the env, the overlay list is empty, and this is where state lives.
    match: /(^|[/\\])claude-(agent|code)-acp(\.[a-z]+)?$/i,
    dirs: ['.claude'],
  },
  {
    match: /(^|[/\\])codex-acp(\.[a-z]+)?$/i,
    dirs: ['.codex'],
  },
  {
    match: /(^|[/\\])goose(\.[a-z]+)?$/i,
    dirs: ['.config/goose', '.local/share/goose'],
  },
];

/**
 * The configured harness's own `$HOME` state roots, absolute.
 *
 * An unrecognised command gets none. If such a harness turns out to need one,
 * the symptom is a clear `EROFS` at `session/new` and the off-switch is one
 * `runtime.json` field away — which is better than pre-creating directories in
 * the operator's home for every harness Beeline has ever heard of.
 */
export function harnessHomeStateDirs(
  agentCommand: string | undefined,
  home: string = homedir(),
): string[] {
  if (!agentCommand) return [];
  for (const { match, dirs } of HARNESS_HOME_STATE_DIRS) {
    if (match.test(agentCommand)) return dirs.map((dir) => resolve(home, dir));
  }
  return [];
}

/** Result of the one-shot start-up feature detection. */
export interface BwrapAvailability {
  /** Absolute path to a `bwrap` that passed the self-test, when usable. */
  path?: string;
  /** One operator-facing line explaining the state. Always present. */
  advisory: string;
}

/** What one session may reach, before it is turned into bwrap argv. */
export interface SandboxMountPlan {
  /**
   * Paths re-bound read-only after the tmpfs that would otherwise hide them.
   *
   * `--tmpfs /tmp` replaces the whole of `/tmp` with an empty filesystem, so a
   * session whose checkout, worktree or harness state happens to live under
   * `/tmp` would find it simply *gone* — a harness silently losing its
   * credentials, or a Room unable to read the code it was asked about. Anything
   * the session must still reach there is restored here, read-only.
   */
  readOnly: string[];
  /** Paths bind-mounted read-write, deduplicated and sorted. */
  writable: string[];
}

export interface SandboxSessionSpec {
  mode: SessionMode;
  /** The child's working directory; also the ACP session cwd. */
  cwd: string;
  /** Corner worktree, for an edit session. */
  worktreePath?: string;
  /**
   * This Room's harness state directories — the `CLAUDE_CONFIG_DIR`/`CODEX_HOME`/
   * `XDG_STATE_HOME`/`XDG_CACHE_HOME` values of the `agent-home.ts` env overlay.
   */
  harnessStateDirs?: string[];
  /**
   * Harness state roots under `$HOME` that no env var relocates — normally
   * {@link harnessHomeStateDirs}. Separate from `harnessStateDirs` only so a
   * caller can supply a test home instead of the daemon's real one.
   */
  harnessHomeStateDirs?: string[];
  /** This Room's `TMPDIR`, when `agent-home.ts` relocated it. */
  tmpDir?: string;
  /** Git common directory backing a corner's linked worktree. */
  gitCommonDir?: string;
}

/** `/tmp` is always a private tmpfs, so a path under it is the shadowed case. */
function isUnderTmp(path: string): boolean {
  const rel = relative('/tmp', path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function normalize(paths: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  for (const path of paths) {
    if (!path) continue;
    seen.add(resolve(path));
  }
  return Array.from(seen).sort();
}

/**
 * The exact mount table for one session. Pure — no filesystem access — so the
 * room-vs-corner difference is a unit-testable value, not spawn-time behaviour.
 */
export function sandboxMountPlan(spec: SandboxSessionSpec): SandboxMountPlan {
  // Harness bookkeeping, both modes — see the module comment for why a Room
  // cannot have this read-only. No part of any repository is in here.
  const harnessState = [
    ...(spec.harnessStateDirs ?? []),
    ...(spec.harnessHomeStateDirs ?? []),
    spec.tmpDir,
  ];
  const writable = normalize(
    spec.mode === 'edit'
      ? [spec.worktreePath, spec.gitCommonDir, ...harnessState]
      : // A Room writes no checkout and no host path — only its own harness
        // state and the private /tmp.
        harnessState,
  );
  // Everything this session must still see through the /tmp tmpfs, minus what a
  // writable bind already restores. `tmpDir` is never restored read-only: under
  // /tmp it is already served, writably, by the private tmpfs.
  const readOnly = normalize([
    spec.cwd,
    spec.worktreePath,
    spec.gitCommonDir,
    ...(spec.harnessStateDirs ?? []),
    ...(spec.harnessHomeStateDirs ?? []),
  ]).filter((path) => isUnderTmp(path) && path !== '/tmp' && !writable.includes(path));
  return { readOnly, writable };
}

export interface WrappedCommand {
  command: string;
  args: string[];
}

/**
 * Wrap `command`/`args` so they run under bwrap with `plan`'s mount table.
 *
 * Argument order is load-bearing and asserted by tests: bwrap applies mount
 * operations in the order given, so `--ro-bind / /` must come first and every
 * per-session mount must come after the `/tmp` tmpfs that would shadow it.
 */
export function buildBwrapArgv(input: {
  bwrapPath: string;
  plan: SandboxMountPlan;
  cwd: string;
  command: string;
  args?: string[];
}): WrappedCommand {
  const args = ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp'];
  for (const path of input.plan.readOnly) args.push('--ro-bind', path, path);
  // `--bind-try`, not `--bind`: a harness state root that has never been created
  // must not make the whole session fail to spawn.
  for (const path of input.plan.writable) args.push('--bind-try', path, path);
  args.push('--chdir', input.cwd);
  // The sandbox must not outlive the daemon that owns the session.
  args.push('--die-with-parent');
  args.push('--', input.command, ...(input.args ?? []));
  return { command: input.bwrapPath, args };
}

/** Convenience: plan + argv in one call. Returns the bare command when disabled. */
export function wrapAgentCommand(input: {
  bwrapPath?: string;
  spec: SandboxSessionSpec;
  command: string;
  args?: string[];
}): WrappedCommand {
  if (!input.bwrapPath) return { command: input.command, args: [...(input.args ?? [])] };
  return buildBwrapArgv({
    bwrapPath: input.bwrapPath,
    plan: sandboxMountPlan(input.spec),
    cwd: input.spec.cwd,
    command: input.command,
    args: input.args,
  });
}

/**
 * The git common directory backing a corner worktree, or undefined when it
 * cannot be resolved — which the caller treats as a reason to skip wrapping that
 * session entirely, since a corner that can edit but never commit is worse than
 * an unwrapped one.
 */
export function resolveGitCommonDir(worktreePath: string): string | undefined {
  const result = spawnSync('git', ['-C', worktreePath, 'rev-parse', '--git-common-dir'], {
    encoding: 'utf8',
  });
  if (result.status !== 0) return undefined;
  const raw = (result.stdout ?? '').trim();
  if (!raw) return undefined;
  return resolve(worktreePath, raw);
}

/**
 * One-shot start-up detection: is there a `bwrap` on this host that can actually
 * build the namespace we intend to spawn into?
 *
 * The self-test is the real mount table (minus the session-specific mounts), not
 * `bwrap --version`: a `bwrap` that exists but cannot unshare is the exact
 * failure this is meant to catch, and it only shows up when it tries.
 */
export function detectBwrapSandbox(
  options: {
    policy?: SandboxPolicy;
    env?: NodeJS.ProcessEnv;
    /** Test seam: run the self-test command. */
    run?: (command: string, args: string[]) => { status: number | null; stderr?: string };
  } = {},
): BwrapAvailability {
  const env = options.env ?? process.env;
  const override = env.BUZZY_BODY_SANDBOX;
  const policy = isSandboxPolicy(override) ? override : (options.policy ?? DEFAULT_SANDBOX_POLICY);
  if (policy === 'off') {
    return {
      advisory:
        'harness OS sandbox DISABLED by configuration (sandbox=off); ACP children run unconfined and the Room read-only rule rests on the permission handler alone',
    };
  }
  const bwrapPath = executableOnPath('bwrap', env);
  if (!bwrapPath) {
    return {
      advisory:
        'harness OS sandbox UNAVAILABLE: bwrap (bubblewrap) is not on PATH; ACP children run unconfined and the Room read-only rule rests on the permission handler alone. Install bubblewrap to enforce it at the OS level.',
    };
  }
  const run =
    options.run ??
    ((command: string, args: string[]) => {
      const result = spawnSync(command, args, { encoding: 'utf8', timeout: 10_000 });
      return { status: result.status, stderr: result.stderr ?? '' };
    });
  const probe = buildBwrapArgv({
    bwrapPath,
    plan: { readOnly: [], writable: [] },
    cwd: '/',
    command: '/bin/true',
  });
  const result = run(probe.command, probe.args);
  if (result.status !== 0) {
    const detail = (result.stderr ?? '').trim().split('\n').pop() ?? `exit ${result.status}`;
    return {
      advisory: `harness OS sandbox UNAVAILABLE: ${bwrapPath} self-test failed (${detail}); ACP children run unconfined and the Room read-only rule rests on the permission handler alone`,
    };
  }
  return {
    path: bwrapPath,
    advisory: `harness OS sandbox ENABLED via ${bwrapPath}: every ACP child gets a read-only filesystem plus a private /tmp, writable only in its own harness state; a corner adds its worktree and git dir`,
  };
}
