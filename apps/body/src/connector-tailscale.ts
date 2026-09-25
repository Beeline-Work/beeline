/**
 * Tailscale connector installation and interactive sign-in.
 *
 * The helper owns the system Tailscale client. We install it with Tailscale's
 * published Linux installer when it is absent, then run `tailscale up` with a
 * bounded wait. An unauthenticated client prints a browser URL; that URL is
 * returned to the Workbench ceremony and no auth key ever enters Beeline.
 */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import type { ConnectorSignIn, ConnectorStep } from '@beeline/api-contract/daemon';

const COMMAND_TIMEOUT_MS = 2 * 60_000;
const OUTPUT_LIMIT = 32 * 1024;
const LOGIN_URL = /https:\/\/login\.tailscale\.com\/[A-Za-z0-9_/-]+/u;

export type TailscaleCommandResult = {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
};

export type TailscaleCommandRunner = (
  command: string,
  args: readonly string[],
) => Promise<TailscaleCommandResult>;

export type InstallTailscaleResult =
  | {
      readonly status: 'connected';
      readonly steps: readonly ConnectorStep[];
      readonly signedInAs?: string;
    }
  | {
      readonly status: 'installing';
      readonly steps: readonly ConnectorStep[];
      readonly signIn: ConnectorSignIn;
    }
  | {
      readonly status: 'error';
      readonly steps: readonly ConnectorStep[];
      readonly errorMessage: string;
    };

function clipped(value: string): string {
  return value.length <= OUTPUT_LIMIT ? value : value.slice(value.length - OUTPUT_LIMIT);
}

export const runTailscaleCommand: TailscaleCommandRunner = (command, args) =>
  new Promise((resolve) => {
    execFile(
      command,
      [...args],
      { timeout: COMMAND_TIMEOUT_MS, maxBuffer: OUTPUT_LIMIT * 2 },
      (error, stdout, stderr) => {
        const code =
          error && 'code' in error && typeof error.code === 'number'
            ? error.code
            : error
              ? null
              : 0;
        resolve({ code, stdout: clipped(stdout), stderr: clipped(stderr) });
      },
    );
  });

type TailscaleStatus = {
  readonly BackendState?: string;
  readonly AuthURL?: string;
  readonly Self?: { readonly UserID?: number };
  readonly User?: Record<string, { readonly LoginName?: string; readonly DisplayName?: string }>;
  readonly CurrentTailnet?: { readonly Name?: string };
};

export function formatToolReachLine(input: {
  readonly can: boolean;
  readonly thing: string;
  readonly because: string;
  readonly fix: string;
}): string {
  return `I ${input.can ? 'can' : "can't"} reach ${input.thing} on this machine because ${input.because}; to fix it, ${input.fix}.`;
}

function loginUrlFrom(status?: TailscaleStatus, output?: string): string | undefined {
  const fromStatus = status?.AuthURL?.trim();
  if (fromStatus) {
    const match = LOGIN_URL.exec(fromStatus)?.[0];
    if (match) return match;
  }
  return output ? LOGIN_URL.exec(output)?.[0] : undefined;
}

function parseStatus(output: string): TailscaleStatus | undefined {
  try {
    const parsed = JSON.parse(output) as TailscaleStatus;
    return parsed && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function accountName(status: TailscaleStatus): string | undefined {
  const userId = status.Self?.UserID;
  const user = userId === undefined ? undefined : status.User?.[String(userId)];
  return user?.LoginName ?? user?.DisplayName ?? status.CurrentTailnet?.Name;
}

function step(
  label: string,
  status: ConnectorStep['status'],
  details: Partial<ConnectorStep> = {},
): ConnectorStep {
  return { label, status, ...details };
}

async function readStatus(run: TailscaleCommandRunner): Promise<TailscaleStatus | undefined> {
  const result = await run('tailscale', ['status', '--json']);
  return parseStatus(result.stdout || result.stderr);
}

async function ensureInstalled(
  run: TailscaleCommandRunner,
  onProgress: (steps: readonly ConnectorStep[]) => void,
  platform: NodeJS.Platform,
): Promise<{ ok: true; steps: ConnectorStep[] } | { ok: false; result: InstallTailscaleResult }> {
  const version = await run('tailscale', ['version']);
  if (version.code === 0) {
    return {
      ok: true,
      steps: [step('Tailscale installed', 'done', { output: version.stdout.trim() })],
    };
  }
  if (platform !== 'linux') {
    const reason = 'Tailscale is not installed; install the Tailscale app on this helper and retry';
    return {
      ok: false,
      result: {
        status: 'error',
        steps: [step('Tailscale installed', 'failed', { reason })],
        errorMessage: reason,
      },
    };
  }

  const script = join(tmpdir(), `beeline-tailscale-install-${process.pid}-${randomUUID()}.sh`);
  const steps: ConnectorStep[] = [
    step('Tailscale installed', 'running', {
      command: 'curl -fsSL https://tailscale.com/install.sh',
    }),
    step('Tailnet signed in', 'pending'),
  ];
  onProgress(steps);
  try {
    const download = await run('curl', ['-fsSL', 'https://tailscale.com/install.sh', '-o', script]);
    if (download.code !== 0) {
      const reason = (
        download.stderr ||
        download.stdout ||
        'Tailscale installer download failed'
      ).trim();
      return {
        ok: false,
        result: {
          status: 'error',
          steps: [step('Tailscale installed', 'failed', { reason })],
          errorMessage: reason,
        },
      };
    }
    const install = await run('sh', [script]);
    if (install.code !== 0) {
      const reason = (install.stderr || install.stdout || 'Tailscale installation failed').trim();
      return {
        ok: false,
        result: {
          status: 'error',
          steps: [step('Tailscale installed', 'failed', { reason })],
          errorMessage: reason,
        },
      };
    }
    return {
      ok: true,
      steps: [step('Tailscale installed', 'done', { output: install.stdout.trim() })],
    };
  } finally {
    await rm(script, { force: true }).catch(() => {});
  }
}

export async function installTailscale(
  options: {
    readonly run?: TailscaleCommandRunner;
    readonly onProgress?: (steps: readonly ConnectorStep[]) => void;
    readonly operator?: string;
    /** Test seam for platform-specific installation and privilege handling. */
    readonly platform?: NodeJS.Platform;
    /** Test seam for the Linux root path. */
    readonly getuid?: () => number;
    /** Reuse the open browser ceremony while polling for completed sign-in. */
    readonly signIn?: ConnectorSignIn;
  } = {},
): Promise<InstallTailscaleResult> {
  const run = options.run ?? runTailscaleCommand;
  const onProgress = options.onProgress ?? (() => {});
  const platform = options.platform ?? process.platform;
  const installed = await ensureInstalled(run, onProgress, platform);
  if (!installed.ok) return installed.result;

  const current = await readStatus(run);
  if (current?.BackendState === 'Running') {
    return {
      status: 'connected',
      steps: [...installed.steps, step('Tailnet signed in', 'done')],
      ...(accountName(current) ? { signedInAs: accountName(current) } : {}),
    };
  }

  if (options.signIn) {
    const steps = [
      ...installed.steps,
      step('Tailnet signed in', 'running', { command: 'tailscale up' }),
    ];
    return { status: 'installing', steps, signIn: options.signIn };
  }

  const pendingUrl = loginUrlFrom(current);
  if (pendingUrl) {
    return {
      status: 'installing',
      steps: [...installed.steps, step('Tailnet signed in', 'running', { command: 'tailscale up' })],
      signIn: { method: 'oauth', url: pendingUrl, browserLocation: { kind: 'none' } },
    };
  }

  const steps = [
    ...installed.steps,
    step('Tailnet signed in', 'running', { command: 'tailscale up' }),
  ];
  onProgress(steps);
  let accountUsername: string | undefined;
  try {
    accountUsername = userInfo().username;
  } catch {
    // Some minimal containers cannot resolve the current account. Root still
    // has direct CLI access; non-root callers get the actionable command error.
  }
  const operator = [options.operator, process.env.USER, accountUsername].find(
    (candidate): candidate is string =>
      typeof candidate === 'string' && /^[A-Za-z_][A-Za-z0-9_-]*$/u.test(candidate),
  );
  const upArgs = ['tailscale', 'up', '--timeout=10s'];
  if (operator) upArgs.push(`--operator=${operator}`);
  const getuid = options.getuid ?? process.getuid;
  const root = getuid?.() === 0;
  const up =
    platform === 'linux' && !root
      ? await run('sudo', ['-n', ...upArgs])
      : await run('tailscale', upArgs.slice(1));

  const after = await readStatus(run);
  if (after?.BackendState === 'Running') {
    return {
      status: 'connected',
      steps: [...installed.steps, step('Tailnet signed in', 'done')],
      ...(accountName(after) ? { signedInAs: accountName(after) } : {}),
    };
  }
  const output = `${up.stdout}\n${up.stderr}`;
  const url = loginUrlFrom(after, output);
  if (url) {
    return {
      status: 'installing',
      steps,
      signIn: { method: 'oauth', url, browserLocation: { kind: 'none' } },
    };
  }
  const reason = (up.stderr || up.stdout || 'Tailscale could not start on this helper').trim();
  return {
    status: 'error',
    steps: [...installed.steps, step('Tailnet signed in', 'failed', { reason })],
    errorMessage: reason,
  };
}

/** Live reachability for workbench_status: one can/can't sentence, and install when enabled. */
export async function describeTailscaleReach(
  options: {
    readonly enabled?: boolean;
    readonly installIfMissing?: boolean;
    readonly run?: TailscaleCommandRunner;
    readonly install?: typeof installTailscale;
  } = {},
): Promise<string> {
  const run = options.run ?? runTailscaleCommand;
  const version = await run('tailscale', ['version']);
  if (version.code !== 0 && options.installIfMissing) {
    const result = await (options.install ?? installTailscale)({ run });
    if (result.status === 'installing') {
      return formatToolReachLine({
        can: false,
        thing: 'Tailscale',
        because: 'this node needs sign-in',
        fix: `the owner should open ${result.signIn.url}`,
      });
    }
    if (result.status === 'connected') {
      return formatToolReachLine({
        can: true,
        thing: 'Tailscale',
        because: result.signedInAs
          ? `this node is connected as ${result.signedInAs}`
          : 'this node is connected',
        fix: 'use the tailscale CLI for tailnet resources',
      });
    }
  }
  if (version.code !== 0) {
    return formatToolReachLine({
      can: false,
      thing: 'Tailscale',
      because: 'the CLI is not installed',
      fix: options.enabled
        ? 'the connector will install it and send the owner a login link'
        : 'offer Tailscale with offer_connector so it can be installed',
    });
  }
  const status = await readStatus(run);
  if (status?.BackendState === 'Running') {
    const account = accountName(status);
    return formatToolReachLine({
      can: true,
      thing: 'Tailscale',
      because: account ? `this node is connected as ${account}` : 'this node is connected',
      fix: 'use the tailscale CLI for tailnet resources',
    });
  }
  const url = loginUrlFrom(status);
  if (url) {
    return formatToolReachLine({
      can: false,
      thing: 'Tailscale',
      because: 'this node needs sign-in',
      fix: `the owner should open ${url}`,
    });
  }
  if (options.installIfMissing) {
    const result = await (options.install ?? installTailscale)({ run });
    if (result.status === 'installing') {
      return formatToolReachLine({
        can: false,
        thing: 'Tailscale',
        because: 'this node needs sign-in',
        fix: `the owner should open ${result.signIn.url}`,
      });
    }
    if (result.status === 'connected') {
      return formatToolReachLine({
        can: true,
        thing: 'Tailscale',
        because: result.signedInAs
          ? `this node is connected as ${result.signedInAs}`
          : 'this node is connected',
        fix: 'use the tailscale CLI for tailnet resources',
      });
    }
  }
  return formatToolReachLine({
    can: false,
    thing: 'Tailscale',
    because: status?.BackendState
      ? `the daemon is ${status.BackendState}`
      : 'the daemon is not running',
    fix: options.enabled
      ? 'the connector will start Tailscale and send the owner a login link'
      : 'offer Tailscale with offer_connector so it can be installed',
  });
}
