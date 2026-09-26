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
 * ## Credential masks

 * The whole-home ro-bind makes the filesystem READ-ONLY, not PRIVATE: the
 * operator's `~/.config/gh`, `~/.ssh`, `~/.netrc` and `~/.git-credentials`
 * are all readable from inside an intact sandbox, and a session that can
 * READ a credential can use it out-of-band. Read-only therefore is not enough
 * for ambient credential stores: corners receive their own repository-scoped
 * GitHub App token instead.
 *
 * Every session (Room and corner) gets MASKS on top of its root bind: an empty
 * tmpfs replaces each masked directory and `/dev/null` each masked file, so
 * their contents are absent, not merely unwritable. The built-in list covers
 * the known credential homes ({@link KNOWN_CREDENTIAL_MASK_PATHS}); an owner
 * whose machine keeps secrets elsewhere extends it via the runtime record's
 * `sandboxMaskPaths` or the `BUZZY_BODY_SANDBOX_MASK` environment variable
 * (comma-separated absolute paths). MCP server configuration and session
 * directories are not on that list — a sandboxed agent can read the host
 * Trusty Squire session.
 *
 * **Residual, stated honestly**: no mask list can enumerate every secret on a
 * shared operator machine — env files, dotfiles, and tool state live
 * everywhere. Beeline hides the stores it knows about and gives repository
 * corners a GitHub App token scoped to the linked repository. Ambient secrets
 * beyond the mask list remain the operator's own exposure on their account.
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
import { execFile, spawnSync } from 'node:child_process';
import { lstatSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';
import { executableOnPath } from './agent-command.js';
import type { SessionMode } from './config.js';
import { CURSOR_HARNESS_COMMAND } from './cursor-acp-bridge.js';

/** Operator switch, persisted on the runtime record and mirrored onto BodyConfig. */
export type SandboxPolicy = 'bwrap' | 'off';

export const DEFAULT_SANDBOX_POLICY: SandboxPolicy = 'bwrap';

export function isSandboxPolicy(value: unknown): value is SandboxPolicy {
  return value === 'bwrap' || value === 'off';
}

/**
 * Harness state roots derived from `$HOME` rather than a dedicated state env.
 * `agent-home.ts` now supplies a per-Room HOME, and the caller passes that home
 * here so these paths stay inside the validated agent-home boundary.
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
    // hard-codes that path, so HOME itself is the relocation boundary.
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
  {
    match: CURSOR_HARNESS_COMMAND,
    dirs: ['.cursor'],
  },
  {
    match: /(^|[/\\])opencode(\.[a-z]+)?$/i,
    dirs: ['.local/share/opencode', '.config/opencode'],
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
  '.beeline/registry-mcp',
] as const;

/** One masked path plus whether it was seen as a directory or a file. */
export interface MaskedPath {
  path: string;
  kind: 'dir' | 'file';
  create?: boolean;
}

/**
 * The credential-mask entries for one host: the built-in known list plus the
 * owner's configured extras, resolved against `$HOME`. Optional entries that
 * do not exist are skipped. Required absent entries get namespace-only
 * directory mountpoints so later-created host paths remain hidden. Existing
 * entry kinds come from a real stat so the argv builder can pick tmpfs vs
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
  requiredPaths: string[] = [],
): MaskedPath[] {
  const required = new Set(requiredPaths.map((path) => resolve(path)));
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
    if (!info) {
      if (required.has(path)) masks.push({ path, kind: 'dir', create: true });
      continue;
    }
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
  /**
   * The ONE sentence a Room/DM session prompt may state about a missing
   * sandbox: a fixed reason plus the operator's one-line fix where one applies.
   * Set only by `ensureBwrapSandbox`, which knows which branch it took.
   *
   * Deliberately not `advisory`: a model is told to say this in a reply every
   * Workspace member can read, so it must carry no host posture, no resolved
   * path, no AppArmor remediation, and no installer output.
   */
  shellDetail?: string;
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
   * Hard-limited scratch filesystems whose mount lives only for this physical
   * sandbox session.
   */
  quotaTmpfs: Array<{ target: string; maxBytes: number; maxInodes: number; blockGit?: boolean }>;
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
  /** Hygiene denylist overlaid read-only in an edit session. */
  protectedPaths?: string[];
  /** Explicit capabilities restored writable after protected parent mounts. */
  additionalWritablePaths?: string[];
  /** Per-session quota workbench mounted at this stable path. */
  workbench?: { dir: string; maxBytes: number; maxInodes: number };
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
          ...(spec.additionalWritablePaths ?? []),
          ...harnessState,
        ]
      : // A Room keeps source files read-only. Its explicit capabilities are
        // limited to harness state, agent-private paths, and release-owned
        // generated state such as the repository's .codegraph index; callers
        // must name each path. /tmp remains private.
        [...(spec.additionalWritablePaths ?? []), ...harnessState],
  );
  // Everything this session must still see through the /tmp tmpfs, minus what a
  // writable bind already restores. `tmpDir` is never restored read-only: under
  // /tmp it is already served, writably, by the private tmpfs.
  const tmpRestores = normalize([
    spec.cwd,
    spec.worktreePath,
    spec.gitCommonDir,
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
    quotaTmpfs: spec.workbench
      ? [
          {
            target: resolve(spec.workbench.dir),
            maxBytes: spec.workbench.maxBytes,
            maxInodes: spec.workbench.maxInodes,
            blockGit: true,
          },
        ]
      : [],
    masks: [...(spec.maskPaths ?? [])],
  };
}

export interface WrappedCommand {
  command: string;
  args: string[];
}

const QUOTA_TMPFS_BOOTSTRAP = [
  'set -eu',
  'mount -t tmpfs -o "remount,size=$2,nr_inodes=$3" tmpfs "$1"',
  'shift 3',
  'exec setpriv --bounding-set=-all --inh-caps=-all --ambient-caps=-all --no-new-privs "$@"',
].join('\n');

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
  const quotaTmpfs = input.plan.quotaTmpfs ?? [];
  const args = [
    '--unshare-pid',
    ...(quotaTmpfs.length
      ? [
          '--unshare-user',
          '--uid',
          '0',
          '--gid',
          '0',
          '--cap-add',
          'CAP_SYS_ADMIN',
          '--cap-add',
          'CAP_SETPCAP',
        ]
      : []),
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
    if (mask.kind === 'dir') {
      if (mask.create) args.push('--dir', mask.path);
      args.push('--tmpfs', mask.path);
    } else args.push('--ro-bind', '/dev/null', mask.path);
  }
  // `--bind-try`, not `--bind`: a harness state root that has never been created
  // must not make the whole session fail to spawn.
  for (const path of input.plan.writable) args.push('--bind-try', path, path);
  for (const binding of quotaTmpfs) {
    args.push(
      '--dir',
      binding.target,
      '--size',
      String(binding.maxBytes),
      '--tmpfs',
      binding.target,
    );
    // The sandbox reserves this leaf. Mounting /dev/null over it makes `.git`
    // neither a directory nor removable, so `git init`, worktree `.git` files,
    // and `cp -r repo/. …` all fail inside the kernel mount table.
    if (binding.blockGit) args.push('--ro-bind', '/dev/null', resolve(binding.target, '.git'));
  }
  args.push('--chdir', input.cwd);
  // The sandbox must not outlive the daemon that owns the session.
  args.push('--die-with-parent');
  if (quotaTmpfs.length) {
    if (quotaTmpfs.length !== 1) throw new Error('only one quota tmpfs is supported per session');
    const quota = quotaTmpfs[0]!;
    args.push(
      '--',
      'sh',
      '-c',
      QUOTA_TMPFS_BOOTSTRAP,
      'beeline-quota-tmpfs',
      quota.target,
      String(quota.maxBytes),
      String(quota.maxInodes),
      input.command,
      ...(input.args ?? []),
    );
  } else {
    args.push('--', input.command, ...(input.args ?? []));
  }
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
    plan: { readOnly: [], writable: [], quotaTmpfs: [], masks: [] },
    cwd: '/',
    command: '/bin/true',
  });
  const result = run(probe.command, probe.args);
  if (result.status !== 0) {
    const detail =
      (result.stderr ?? '').trim().split('\n').filter(Boolean).pop() ?? `exit ${result.status}`;
    const appArmorRemediation =
      /No permissions to create (?:a )?new namespace|setting up uid map: Permission denied|userns_create/i.test(
        result.stderr ?? '',
      )
        ? " Ubuntu AppArmor may be blocking unprivileged user namespaces. If the agent's user service inherited an AppArmor profile, reinstall the Beeline user unit and restart the agent; the unit explicitly transitions to unconfined before /usr/bin/bwrap enters Ubuntu's bwrap profile."
        : '';
    return {
      advisory: `harness OS sandbox UNAVAILABLE: ${bwrapPath} self-test failed (${detail}); ACP children run unconfined and the Room read-only rule rests on the permission handler alone.${appArmorRemediation}`,
    };
  }
  return {
    path: bwrapPath,
    advisory: `harness OS sandbox ENABLED via ${bwrapPath}: every ACP child gets a read-only filesystem plus a private /tmp and PID namespace, writable only in its own harness state; ambient credential stores (~/.config/gh, ~/.ssh, ~/.netrc, ~/.git-credentials) are masked absent; a repository corner adds its worktree and git dir, then receives its linked repository's GitHub App credential. Hygiene boundary, not confinement — it shapes where sessions write files and does not restrict other access this account has (e.g. sockets, container runtimes, secrets not on the mask list)`,
  };
}

/** The one command an operator runs when Beeline could not install bubblewrap itself. */
export const BUBBLEWRAP_INSTALL_FIX = 'sudo apt-get install -y bubblewrap';

/**
 * …and the same instruction for a host with no apt-get, where naming a command
 * would be guessing at a package manager nobody confirmed is here.
 */
export const BUBBLEWRAP_INSTALL_FIX_UNKNOWN_MANAGER = "install this host's bubblewrap package";

export type SandboxInstallResult = {
  readonly code: number | null;
  readonly output: string;
};

export type SandboxInstallRunner = (
  command: string,
  args: readonly string[],
) => Promise<SandboxInstallResult>;

const INSTALL_TIMEOUT_MS = 2 * 60_000;
const INSTALL_OUTPUT_LIMIT = 32 * 1024;

/**
 * Worst case for the refresh + install pair, for a caller that has to keep this
 * off a start-up deadline it does not own (`cli.ts` extends the systemd start
 * timeout by exactly this before the first package command runs).
 */
export const BUBBLEWRAP_INSTALL_BUDGET_MS = 2 * INSTALL_TIMEOUT_MS + 15_000;

/**
 * A failed install is remembered for a day, so a host where bubblewrap is simply
 * unobtainable stops paying an `apt-get update` + install before READY on every
 * `Restart=always` bounce, managed-update activation, and hiccup restart. The
 * marker is only ever consulted AFTER detection finds no `bwrap`, so an operator
 * who installs it by hand is picked up on the very next start whatever the
 * marker says.
 */
const INSTALL_RETRY_AFTER_HOURS = 24;
const INSTALL_RETRY_AFTER_MS = INSTALL_RETRY_AFTER_HOURS * 60 * 60_000;
const INSTALL_FAILURE_MARKER = 'bubblewrap-install-failed';

function installFailureMarker(stateDir: string): string {
  return resolve(stateDir, INSTALL_FAILURE_MARKER);
}

function readInstallFailure(stateDir: string | undefined): number | undefined {
  if (!stateDir) return undefined;
  try {
    const at = Number.parseInt(readFileSync(installFailureMarker(stateDir), 'utf8').trim(), 10);
    return Number.isFinite(at) ? at : undefined;
  } catch {
    return undefined;
  }
}

/** A helper that cannot write its own state directory still starts. */
function recordInstallFailure(stateDir: string | undefined, at: number): void {
  if (!stateDir) return;
  try {
    writeFileSync(installFailureMarker(stateDir), `${at}\n`, 'utf8');
  } catch {
    // Losing the memory costs a repeated attempt, never a start.
  }
}

function clearInstallFailure(stateDir: string | undefined): void {
  if (!stateDir) return;
  try {
    rmSync(installFailureMarker(stateDir), { force: true });
  } catch {
    // Same: a stale marker only delays a retry.
  }
}

export const runSandboxInstallCommand: SandboxInstallRunner = (command, args) =>
  new Promise((resolve) => {
    execFile(
      command,
      [...args],
      {
        timeout: INSTALL_TIMEOUT_MS,
        maxBuffer: INSTALL_OUTPUT_LIMIT * 2,
        // A dpkg prompt on a host with a held conffile would otherwise sit on
        // its stdin until the timeout kills the whole attempt.
        env: { ...process.env, DEBIAN_FRONTEND: 'noninteractive' },
      },
      (error, stdout, stderr) => {
        const code =
          error && 'code' in error && typeof error.code === 'number'
            ? error.code
            : error
              ? null
              : 0;
        const output = [stdout, stderr].join('').trim();
        resolve({ code, output: output || (error ? error.message : '') });
      },
    );
  });

function lastLine(output: string, fallback: string): string {
  return (
    output
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .pop() ?? fallback
  );
}

/**
 * The ONE instruction this host's operator can actually follow — the same
 * question `installBubblewrap` answers by refusing to run, so a host with no
 * apt-get is never told to run apt.
 */
function bubblewrapPackageSupport(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
):
  | { readonly servable: true; readonly fix: string }
  | { readonly servable: false; readonly reason: string; readonly fix: string } {
  if (platform !== 'linux') {
    return {
      servable: false,
      reason: 'bubblewrap is packaged for Linux only',
      fix: BUBBLEWRAP_INSTALL_FIX_UNKNOWN_MANAGER,
    };
  }
  if (!executableOnPath('apt-get', env)) {
    return {
      servable: false,
      reason: 'this host has no apt-get, so Beeline has no package manager to install it with',
      fix: BUBBLEWRAP_INSTALL_FIX_UNKNOWN_MANAGER,
    };
  }
  return { servable: true, fix: BUBBLEWRAP_INSTALL_FIX };
}

/**
 * One install attempt on a host `bubblewrapPackageSupport` already cleared, as
 * the unprivileged helper account: `sudo -n` only, because the agent runs as a
 * systemd `--user` unit and never as root.
 *
 * `apt-get update` runs first — a host whose cache predates the package's
 * arrival answers "Unable to locate package" otherwise — but it is BEST-EFFORT
 * and its exit code is the verdict on nothing. One unreachable third-party repo
 * or a rotated signing key exits it non-zero on a host where bubblewrap installs
 * fine from the base archive, and only the install itself can establish that the
 * package is unobtainable, which is the whole meaning of the failure marker.
 */
async function installBubblewrap(
  run: SandboxInstallRunner,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }> {
  await run('sudo', ['-n', 'apt-get', 'update']);
  const install = await run('sudo', ['-n', 'apt-get', 'install', '-y', 'bubblewrap']);
  if (install.code === 0) return { ok: true };
  return {
    ok: false,
    reason: lastLine(install.output, `apt-get install exited ${install.code}`),
  };
}

/** Fixed prompt sentences: no host posture, no paths, no installer output. */
const SHELL_DETAIL_SANDBOX_OFF =
  'A shell cannot run here because this helper’s OS sandbox is turned off by its operator.';
const SHELL_DETAIL_SELF_TEST =
  'A shell cannot run here because this host’s OS sandbox failed its start-up self-test.';
const shellDetailNotInstalled = (fix: string): string =>
  `A shell cannot run here because bubblewrap is not installed and Beeline could not install it — ${fix}, then restart the agent.`;

/**
 * The OS sandbox this host can actually provide, installing bubblewrap once
 * when it is simply absent.
 *
 * A Room shell is approved only while the sandbox that holds the Room's
 * read-only filesystem wraps the session (`monolith-room-turn.ts`), so a host
 * without `bwrap` has no Room shell at all — which is worth one install
 * attempt, the same way the Tailscale connector installs its own client rather
 * than asking a person to. Re-detection afterwards is the real self-test, not
 * `--version` and not the installer's exit code: an installed `bwrap` that
 * cannot unshare is still no sandbox, and an install the runner reported as
 * failed (killed at the timeout, output over the buffer) may have completed —
 * so detection always runs again and its verdict wins.
 * `sandbox: 'off'` is an operator decision and installs nothing, and a `bwrap`
 * that is present but failed its self-test is not a missing package.
 *
 * Detection ALWAYS runs before the failure marker is read, so a hand-installed
 * `bwrap` is adopted immediately however recently an attempt failed — including
 * one a sibling helper installed while this one lost the package-manager lock;
 * only a host that still has none consults the marker and skips the package
 * commands.
 *
 * `beforeInstall` fires once, only when a package command is actually about to
 * run: the caller owns whatever deadline that spend comes out of.
 */
export async function ensureBwrapSandbox(
  options: {
    policy?: SandboxPolicy;
    env?: NodeJS.ProcessEnv;
    run?: SandboxInstallRunner;
    /** Test seam: the same one-shot detection the daemon runs at start. */
    detect?: typeof detectBwrapSandbox;
    platform?: NodeJS.Platform;
    beforeInstall?: () => void | Promise<void>;
    /** Where the install-failure marker lives; omitted keeps no memory at all. */
    stateDir?: string;
    now?: () => number;
  } = {},
): Promise<BwrapAvailability> {
  const detect = options.detect ?? detectBwrapSandbox;
  const detectInput = {
    ...(options.policy ? { policy: options.policy } : {}),
    ...(options.env ? { env: options.env } : {}),
  };
  const detected = detect(detectInput);
  if (detected.path) return detected;
  const env = options.env ?? process.env;
  const override = env.BUZZY_BODY_SANDBOX;
  const policy = isSandboxPolicy(override) ? override : (options.policy ?? DEFAULT_SANDBOX_POLICY);
  const shellConsequence = 'A Room shell stays refused while the OS sandbox is unavailable.';
  if (policy === 'off') {
    return {
      advisory: `${detected.advisory} ${shellConsequence}`,
      shellDetail: SHELL_DETAIL_SANDBOX_OFF,
    };
  }
  if (executableOnPath('bwrap', env)) {
    return {
      advisory: `${detected.advisory} ${shellConsequence}`,
      shellDetail: SHELL_DETAIL_SELF_TEST,
    };
  }
  const platform = options.platform ?? process.platform;
  const now = options.now ?? Date.now;
  const support = bubblewrapPackageSupport(platform, env);
  const failed = (reason: string): BwrapAvailability => ({
    advisory:
      `${detected.advisory} ${shellConsequence} Automatic bubblewrap install failed: ` +
      `${reason}; ${support.fix}, then restart the agent.`,
    shellDetail: shellDetailNotInstalled(support.fix),
  });
  if (!support.servable) return failed(support.reason);
  const failedAt = readInstallFailure(options.stateDir);
  if (failedAt !== undefined && now() - failedAt < INSTALL_RETRY_AFTER_MS) {
    return {
      advisory:
        `${detected.advisory} ${shellConsequence} A bubblewrap install already failed on this ` +
        `host within the last ${INSTALL_RETRY_AFTER_HOURS} hours, so this start did not retry ` +
        `it; ${support.fix}, then restart the agent.`,
      shellDetail: shellDetailNotInstalled(support.fix),
    };
  }
  await options.beforeInstall?.();
  const installed = await installBubblewrap(options.run ?? runSandboxInstallCommand);
  const after = detect(detectInput);
  if (after.path) {
    clearInstallFailure(options.stateDir);
    return after;
  }
  if (!installed.ok) {
    recordInstallFailure(options.stateDir, now());
    return failed(installed.reason);
  }
  const stillAbsent = !executableOnPath('bwrap', env);
  if (stillAbsent) recordInstallFailure(options.stateDir, now());
  else clearInstallFailure(options.stateDir);
  return {
    advisory: `${after.advisory} ${shellConsequence}`,
    shellDetail: stillAbsent ? shellDetailNotInstalled(support.fix) : SHELL_DETAIL_SELF_TEST,
  };
}
