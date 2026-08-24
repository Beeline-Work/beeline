/**
 * OS-level sandbox for ACP harness child processes (bubblewrap).
 *
 * ## What this boundary IS
 *
 * `session-sandbox.ts` is the ACP callback boundary: a Room denies every
 * mutating request, while a corner immediately approves ordinary actions and
 * rejects only writes aimed at the hygiene denylist. That callback binds only
 * a harness that actually calls `session/request_permission`; one shipped
 * adapter (`pi-acp`) never does, and corner autonomy modes intentionally stop
 * the other shipped adapters from asking in edit sessions.
 *
 * This module adds the layer underneath: when `bwrap` is available, Rooms run
 * on a read-only filesystem while corners run on a writable filesystem with a
 * small hygiene denylist overlaid read-only.
 *
 * **What it separates is product hygiene, not privilege.** A Room is the
 * conversational, project-management, ideation channel and is meant to stay
 * pristine; a corner is where edits happen. The read-only mount keeps an agent's
 * incidental file activity out of the surfaces that are not its edit target,
 * including the canonical checkout a Room reads from and the operator's own
 * working tree. It is the same trust level as the agent itself: Beeline agents
 * run on the operator's own account, on the operator's own host, with no more
 * and no less standing than any other coding assistant that account runs.
 *
 * ## What this boundary is NOT
 *
 * **It is not a security perimeter against a determined or compromised agent,
 * and it must not be described as one.** A read-only bind constrains filesystem
 * writes through the mount namespace; it does not constrain anything else the
 * operator's account can reach. Proven on a real host (bubblewrap 0.9.0): from
 * inside an intact sandbox —
 *
 * ```
 *   $ bwrap --ro-bind / / --dev /dev --proc /proc --tmpfs /tmp \
 *       sh -c 'echo x > /home/<op>/.probe'
 *   sh: 1: cannot create /home/<op>/.probe: Read-only file system   # works
 *
 *   $ bwrap --ro-bind / / --dev /dev --proc /proc --tmpfs /tmp \
 *       sh -c 'docker run --rm -v /home/<op>:/h <image> \
 *              sh -c "echo escaped > /h/.probe"'
 *   $ cat /home/<op>/.probe                                          # escaped
 * ```
 *
 * Talking to `/var/run/docker.sock` is a socket connection, not a filesystem
 * write, so the ro-bind does not block it — and membership in the host's
 * `docker` group is root-equivalent, so a container can bind-mount any host
 * path read-write. The session bus (`/run/user/<uid>/bus`) is the same class:
 * `systemd-run --user` starts units outside the namespace. On such hosts this
 * sandbox shapes where an ordinary session's file edits land; it does not fence
 * a session off from the machine, and nothing downstream should assume it does.
 * (Multi-user isolation between different people sharing a host is a separate,
 * known-open design question — deliberately out of scope here.)
 *
 * ## Mount table
 *
 * A Room starts from this base:
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
 * A corner instead starts with `--bind / /`: ordinary host locations such as
 * package caches, toolchain directories and build scratch space are writable
 * without being enumerated. It then overlays the canonical checkout, the pool
 * containing every corner worktree, and Body's daemon-owned Room state
 * read-only. The current worktree and its git common directory are rebound
 * writable after those overlays. This is deliberately a denylist, not an
 * allowlist: corner autonomy means normal development tools can install and
 * build wherever they normally do, while sibling work and daemon state stay
 * pristine.
 *
 * **Both modes** get read-write binds for the harness's own state
 * directories: the `CLAUDE_CONFIG_DIR`/`CODEX_HOME`/`XDG_*`/`TMPDIR` overlay
 * from `agent-home.ts`, plus {@link harnessHomeStateDirs} for the state roots no
 * env var relocates. **A Room having writable harness state is a deliberate,
 * measured departure from "a Room writes nothing but /tmp", and it is not
 * optional**: with those directories read-only, `codex-acp` cannot start a Room
 * session at all (`failed to initialize sqlite state runtime under …/codex`) and
 * `pi-acp` cannot start one in either mode (`EROFS … open
 * '~/.pi/pi-acp/session-map.json'`). A sandbox that bricks two of the three
 * shipped harnesses is strictly worse than the gap it closes. Harness state is
 * neither the repository nor the operator's tree, so the ordinary-session
 * property is intact: a Room's own file writes stay out of every checkout and
 * out of the operator's tree. That is a statement about where a session's file
 * edits land by default — not about what a determined session can reach through
 * non-filesystem channels (see "What this boundary is NOT" above).
 *
 * **Corner (`edit`)** rebinds the two protected paths an edit session owns:
 * its own worktree inside the protected corners pool, and the repository's
 * **git common directory** inside the protected canonical checkout. That second
 * one is required, not incidental — a corner worktree is a *linked* `git
 * worktree`, so its refs, index and newly written objects all live under the
 * canonical checkout's `.git`. Without it a corner could edit files but never
 * commit. The canonical checkout's *working tree* stays read-only in both modes.
 *
 * A corner also gets {@link mergeGateStateDirs} — today exactly
 * `~/.no-mistakes` — writably: an edit session drives the no-mistakes merge
 * gate from inside its namespace, and although reaching the shared daemon
 * socket works through the read-only mount (which is why gate health checks
 * kept passing), initializing or driving the gate writes run state, locks and
 * per-repo records under that root. Missing it reproduced as a corner dying
 * with "state repository directory is mounted read-only" while every health
 * check passed. A Room does NOT get this bind: the gate is not part of a
 * Room's surface.
 *
 * ## Credential masks

 * The whole-home ro-bind makes the filesystem READ-ONLY, not PRIVATE: the
 * operator's `~/.config/gh`, `~/.ssh`, `~/.netrc` and `~/.git-credentials`
 * are all readable from inside an intact sandbox, and a session that can
 * READ a credential can use it out-of-band — including pushing to main
 * directly, which is exactly what the product's approval invariant forbids.
 * Read-only therefore is not enough for credential stores.
 *
 * Every session (Room and corner) gets MASKS on top of its root bind: an empty
 * tmpfs replaces each masked directory and `/dev/null` each masked file, so
 * their contents are absent, not merely unwritable. The built-in list covers
 * the known credential homes ({@link KNOWN_CREDENTIAL_MASK_PATHS}); an owner
 * whose machine keeps secrets elsewhere extends it via the runtime record's
 * `sandboxMaskPaths` or the `BUZZY_BODY_SANDBOX_MASK` environment variable
 * (comma-separated absolute paths).
 *
 * **Residual, stated honestly**: no mask list can enumerate every secret on a
 * shared operator machine — env files, dotfiles, and tool state live
 * everywhere, and this machine's owner has gh credentials "in env files
 * everywhere". What Beeline guarantees structurally is that it HANDS a
 * session nothing (`buildAgentEnv` strips push-capable token variables;
 * `push-broker.ts` funnels every daemon-performed push through ref policy)
 * and hides the stores it knows about. Ambient secrets beyond that list are
 * the operator's own exposure on their own account, and every brokered push
 * at least leaves one audit line naming who pushed what where. The strong
 * posture for hosts where this matters is running daemons under a dedicated
 * user account with no gh/git credentials of its own — recommended, not
 * enforced here.
 *
 * Capabilities that pierce the namespace entirely (a reachable
 * `/var/run/docker.sock`, the systemd user bus) override ALL of the above by
 * owner choice; see "What this boundary is NOT".
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
 * every spawn afterwards is unwrapped. Room callbacks remain fail-closed;
 * corner callbacks can enforce the denylist only for harnesses that still ask.
 */
import { spawnSync } from 'node:child_process';
import { lstatSync } from 'node:fs';
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
  {
    match: /(^|[/\\])grok(\.[a-z]+)?$/i,
    dirs: ['.grok'],
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

/**
 * Tool state roots under `$HOME` that a CORNER (edit) session needs writably,
 * beyond any one harness's own state ({@link HARNESS_HOME_STATE_DIRS}).
 *
 * Today exactly one entry: the no-mistakes merge gate keeps its pipeline state
 * — repo registry, run database, daemon socket directory, lock files — under
 * `~/.no-mistakes`. A sandboxed corner invokes that gate from inside its
 * namespace regardless of which harness runs, so unlike the harness list this
 * is keyed on no command: it is always bound for edit sessions.
 *
 * Deliberately a shared writable bind, NOT relocated per session via the tool's
 * own `NM_HOME` override: the gate's daemon and run history are shared host
 * state (one instance serves every repository and lane), and a per-corner home
 * would leave every corner unable to reach that daemon and trying to spawn its
 * own inside its namespace. Two ordinary terminals on this host share the same
 * root; a corner is entitled to exactly that much.
 */
export const MERGE_GATE_HOME_STATE_DIRS = ['.no-mistakes'];

/** The merge gate's `$HOME` state roots, absolute. See {@link MERGE_GATE_HOME_STATE_DIRS}. */
export function mergeGateStateDirs(home: string = homedir()): string[] {
  return MERGE_GATE_HOME_STATE_DIRS.map((dir) => resolve(home, dir));
}

/**
 * Home-relative paths whose contents must be ABSENT from every sandboxed
 * session — readable credentials are usable credentials, and the whole-home
 * read-only bind does not hide anything. Directories are replaced by an empty
 * writable tmpfs (so tools that insist on writing e.g. `known_hosts` still
 * work against nothing), files by `/dev/null`.
 */
export const KNOWN_CREDENTIAL_MASK_PATHS = [
  '.config/gh',
  '.ssh',
  '.netrc',
  '.git-credentials',
  '.secrets.env',
] as const;

/** One masked path plus whether it was seen as a directory or a file. */
export interface MaskedPath {
  path: string;
  kind: 'dir' | 'file';
}

/**
 * The credential-mask entries for one host: the built-in known list plus the
 * owner's configured extras, resolved against `$HOME`. Entries that do not
 * exist on this host are skipped — bwrap cannot mount over a missing target —
 * and `kind` comes from a real stat so the argv builder can pick tmpfs vs
 * `/dev/null` without touching the filesystem itself.
 */
export function credentialMaskPaths(
  extraPaths: string[] | undefined,
  home: string = homedir(),
  stat: (path: string) => { isDirectory: boolean } | undefined = (path) => {
    try {
      const info = lstatSync(path);
      return { isDirectory: info.isDirectory() };
    } catch {
      return undefined;
    }
  },
): MaskedPath[] {
  const candidates = [
    ...KNOWN_CREDENTIAL_MASK_PATHS.map((entry) => resolve(home, entry)),
    ...(extraPaths ?? []).map((entry) => resolve(entry)),
  ];
  const seen = new Set<string>();
  const masks: MaskedPath[] = [];
  for (const path of candidates) {
    if (seen.has(path)) continue;
    seen.add(path);
    const info = stat(path);
    if (!info) continue;
    masks.push({ path, kind: info.isDirectory ? 'dir' : 'file' });
  }
  return masks.sort((a, b) => a.path.localeCompare(b.path));
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
  /** Edit sessions start writable-by-default; Rooms keep the read-only root. */
  rootWritable?: boolean;
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
  /**
   * Credential stores replaced by emptiness (empty tmpfs for directories,
   * `/dev/null` for files). Emitted AFTER the whole-home ro-bind — which
   * would otherwise expose them read-only — and BEFORE the writable binds,
   * so a deliberate harness-state bind always wins over a mask.
   */
  masks: MaskedPath[];
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
  /**
   * Tool state roots only an EDIT session may write — normally
   * {@link mergeGateStateDirs}. Separate from the harness lists so a caller can
   * supply a test home instead of the daemon's real one, like them.
   */
  mergeGateStateDirs?: string[];
  /** Hygiene denylist overlaid read-only in an edit session. */
  protectedPaths?: string[];
  /** Explicit capabilities restored writable after protected parent mounts. */
  additionalWritablePaths?: string[];
  /** Credential stores hidden from this session ({@link credentialMaskPaths}).
   * Both modes get them: a Room reading the operator's gh token is the same
   * out-of-band-push hole a corner would be. */
  maskPaths?: MaskedPath[];
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
      ? [
          spec.worktreePath,
          spec.gitCommonDir,
          ...(spec.mergeGateStateDirs ?? []),
          ...(spec.additionalWritablePaths ?? []),
          ...harnessState,
        ]
      : // A Room writes no checkout and no host path — only its own harness
        // state, explicitly granted agent-private paths (persistent memory and
        // the ephemeral workbench — never the repo), and the private /tmp.
        // The merge gate is not a Room surface.
        [...(spec.additionalWritablePaths ?? []), ...harnessState],
  );
  // Everything this session must still see through the /tmp tmpfs, minus what a
  // writable bind already restores. `tmpDir` is never restored read-only: under
  // /tmp it is already served, writably, by the private tmpfs.
  const tmpRestores = normalize([
    spec.cwd,
    spec.worktreePath,
    spec.gitCommonDir,
    ...(spec.mergeGateStateDirs ?? []),
    ...(spec.harnessStateDirs ?? []),
    ...(spec.harnessHomeStateDirs ?? []),
  ]).filter((path) => isUnderTmp(path) && path !== '/tmp' && !writable.includes(path));
  const readOnly = normalize([
    ...(spec.mode === 'edit' ? (spec.protectedPaths ?? []) : []),
    ...tmpRestores,
  ]).filter((path) => !writable.includes(path));
  return {
    ...(spec.mode === 'edit' ? { rootWritable: true } : {}),
    readOnly,
    writable,
    masks: [...(spec.maskPaths ?? [])],
  };
}

export interface WrappedCommand {
  command: string;
  args: string[];
}

/**
 * Wrap `command`/`args` so they run under bwrap with `plan`'s mount table.
 *
 * Argument order is load-bearing and asserted by tests: bwrap applies mount
 * operations in the order given, so the root bind must come first and every
 * per-session mount must come after the `/tmp` tmpfs that would shadow it.
 */
export function buildBwrapArgv(input: {
  bwrapPath: string;
  plan: SandboxMountPlan;
  cwd: string;
  command: string;
  args?: string[];
}): WrappedCommand {
  const args = [
    input.plan.rootWritable ? '--bind' : '--ro-bind',
    '/',
    '/',
    '--dev',
    '/dev',
    '--proc',
    '/proc',
    '--tmpfs',
    '/tmp',
  ];
  for (const path of input.plan.readOnly) args.push('--ro-bind', path, path);
  // Credential masks: applied after the ro-bind they override and before the
  // writable binds a deliberate harness-state bind would win with. A masked
  // DIRECTORY becomes an empty writable tmpfs (tools may write into nothing);
  // a masked FILE becomes /dev/null (readable, empty).
  for (const mask of input.plan.masks) {
    if (mask.kind === 'dir') args.push('--tmpfs', mask.path);
    else args.push('--ro-bind', '/dev/null', mask.path);
  }
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
    plan: { readOnly: [], writable: [], masks: [] },
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
    advisory: `harness OS sandbox ENABLED via ${bwrapPath}: every ACP child gets a read-only filesystem plus a private /tmp, writable only in its own harness state; known credential stores (~/.config/gh, ~/.ssh, ~/.netrc, ~/.git-credentials) are masked absent; a corner adds its worktree, git dir, and the merge gate's state root. Hygiene boundary, not confinement — it shapes where sessions write files and does not restrict other access this account has (e.g. sockets, container runtimes, secrets not on the mask list)`,
  };
}
