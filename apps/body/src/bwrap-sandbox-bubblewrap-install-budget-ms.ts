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
 *                        Approved `device` grants are
 *                        bound into it with `--dev-bind-try`, so an absent node is
 *                        skipped. A device carries only the access this
 *                        account already has on the host.
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
 * `sandboxMaskPaths` or the `BEELINE_BODY_SANDBOX_MASK` environment variable
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
 * For the shared Workspace layout, stable `workspaces/` and `agents/` parents
 * are masked, then the selected Workspace's assets and Room's private harness
 * home are rebound. This keeps transcripts, harness state and daemon control
 * records private while allowing the same Workspace assets in every session.
 * {@link siblingAgentMaskPaths} remains only for legacy private-layout turns.
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
import { execFile } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { executableOnPath } from './agent-command.js';
import { SandboxInstallRunner, INSTALL_OUTPUT_LIMIT, BUBBLEWRAP_INSTALL_FIX_UNKNOWN_MANAGER, BUBBLEWRAP_INSTALL_FIX, SandboxPolicy, detectBwrapSandbox, BwrapAvailability, DEFAULT_SANDBOX_POLICY } from './bwrap-sandbox.js';



export const INSTALL_TIMEOUT_MS = 2 * 60_000;


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
  const policy = options.policy ?? DEFAULT_SANDBOX_POLICY;
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
