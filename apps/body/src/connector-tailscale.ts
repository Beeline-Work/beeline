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
import { tmpdir } from 'node:os';
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
  readonly Self?: { readonly UserID?: number };
  readonly User?: Record<string, { readonly LoginName?: string; readonly DisplayName?: string }>;
  readonly CurrentTailnet?: { readonly Name?: string };
};

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
): Promise<{ ok: true; steps: ConnectorStep[] } | { ok: false; result: InstallTailscaleResult }> {
  const version = await run('tailscale', ['version']);
  if (version.code === 0) {
    return {
      ok: true,
      steps: [step('Tailscale installed', 'done', { output: version.stdout.trim() })],
    };
  }
  if (process.platform !== 'linux') {
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
    /** Reuse the open browser ceremony while polling for completed sign-in. */
    readonly signIn?: ConnectorSignIn;
  } = {},
): Promise<InstallTailscaleResult> {
  const run = options.run ?? runTailscaleCommand;
  const onProgress = options.onProgress ?? (() => {});
  const installed = await ensureInstalled(run, onProgress);
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

  const steps = [
    ...installed.steps,
    step('Tailnet signed in', 'running', { command: 'tailscale up' }),
  ];
  onProgress(steps);
  const operator = options.operator ?? process.env.USER;
  const upArgs = ['tailscale', 'up', '--timeout=10s'];
  if (operator && /^[A-Za-z_][A-Za-z0-9_-]*$/u.test(operator))
    upArgs.push(`--operator=${operator}`);
  const up =
    process.platform === 'linux'
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
  const url = LOGIN_URL.exec(output)?.[0];
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
