export const INSTALL_TIMEOUT_MS = 2 * 60_000;
import { execFile } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { executableOnPath } from './agent-command.js';
import { SandboxInstallRunner, INSTALL_OUTPUT_LIMIT, BUBBLEWRAP_INSTALL_FIX_UNKNOWN_MANAGER, BUBBLEWRAP_INSTALL_FIX, SandboxPolicy, detectBwrapSandbox, BwrapAvailability, DEFAULT_SANDBOX_POLICY } from './bwrap-sandbox.js';



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
