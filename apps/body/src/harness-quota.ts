/**
 * Plan quota for harnesses whose ACP adapter reports none (Codex, Cursor,
 * Grok, OpenCode Go). After a turn the helper runs the pinned quota-axi CLI in
 * the agent's own environment, so it reads that agent's own login, and turns
 * its report into the `AgentUsage` windows the owner's Profile shows.
 *
 * quota-axi never refreshes credentials here (`--no-credential-refresh`), never
 * prompts a keychain, and never spends inference. Its output carries no token.
 */
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { AgentUsage, UsageWindow } from '@beeline/api-contract/daemon';
import type { AgentKind } from './agent-command.js';

/** Bundled next to `beeline-cli.mjs` by `scripts/build-beeline-bundle.mjs`. */
export const QUOTA_AXI_BUNDLE_FILE = 'quota-axi.mjs';
const READ_TIMEOUT_MS = 30_000;
/** One vendor read per agent per interval keeps clear of usage-endpoint limits. */
export const QUOTA_READ_INTERVAL_MS = 5 * 60_000;
const MAX_WINDOWS = 8;

/**
 * The quota-axi provider for a harness, or undefined when the harness already
 * reports its own windows (Claude over ACP) or bills through OpenRouter.
 */
export function quotaAxiProvider(kind: AgentKind | undefined, openRouter: boolean): string | undefined {
  if (openRouter) return;
  switch (kind) {
    case 'codex':
    case 'cursor':
    case 'grok':
      return kind;
    case 'opencode':
      return 'opencode-go';
    default:
      return;
  }
}

export function quotaAxiLaunch(
  meta: string = import.meta.url,
  entry: string | undefined = process.argv[1],
): { command: string; args: string[] } {
  if (meta.startsWith('beeline:')) {
    if (!entry) throw new Error('quota-axi cannot resolve the Beeline CLI entry');
    return { command: process.execPath, args: [join(dirname(entry), QUOTA_AXI_BUNDLE_FILE)] };
  }
  // The package exports only its library entry; its CLI sits beside it.
  const library = createRequire(meta).resolve('quota-axi');
  return { command: process.execPath, args: [join(dirname(library), '../bin/quota-axi.js')] };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** One provider's quota-axi `--json` report as Beeline usage; unknown fields are ignored. */
export function quotaAxiUsage(
  report: unknown,
  provider: string,
  now = Date.now() / 1000,
): AgentUsage | undefined {
  const providers = record(report)?.providers;
  if (!Array.isArray(providers)) return;
  const entry = providers.map(record).find((p) => p?.provider === provider);
  if (!entry) return;
  const windows = new Map<string, UsageWindow>();
  for (const raw of Array.isArray(entry.windows) ? entry.windows : []) {
    const w = record(raw);
    const remaining = w?.percentRemaining;
    if (!w || typeof w.id !== 'string' || typeof remaining !== 'number' || !Number.isFinite(remaining))
      continue;
    const rateLimitType = w.id
      .toLowerCase()
      .replace(/[^a-z]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 64);
    if (!rateLimitType || windows.has(rateLimitType) || windows.size >= MAX_WINDOWS) continue;
    const left = Math.min(100, Math.max(0, remaining));
    const resetsAt = typeof w.resetsAt === 'string' ? Date.parse(w.resetsAt) / 1000 : NaN;
    const label = typeof w.label === 'string' ? w.label.trim().slice(0, 40) : '';
    windows.set(rateLimitType, {
      rateLimitType,
      status: left <= 0 ? 'rejected' : 'allowed',
      utilization: (100 - left) / 100,
      ...(Number.isFinite(resetsAt) && resetsAt > 0 ? { resetsAt } : {}),
      updatedAt: now,
      ...(label ? { label } : {}),
    });
  }
  const credits = record(entry.credits);
  const creditsLeft =
    credits?.unit === 'credits' &&
    credits.unlimited !== true &&
    typeof credits.remaining === 'number' &&
    Number.isFinite(credits.remaining) &&
    credits.remaining >= 0
      ? credits.remaining
      : undefined;
  if (!windows.size && creditsLeft === undefined) return;
  const plan = typeof entry.plan === 'string' ? entry.plan.trim().slice(0, 40) : '';
  return {
    updatedAt: now,
    windows: [...windows.values()],
    ...(plan ? { plan } : {}),
    ...(creditsLeft !== undefined ? { credits: { remaining: creditsLeft } } : {}),
  };
}

export type QuotaAxiRun = (
  launch: { command: string; args: string[] },
  env: Record<string, string>,
) => Promise<string>;

/** Exit 1 still prints the report (every provider failed), so read stdout either way. */
const runQuotaAxi: QuotaAxiRun = (launch, env) =>
  new Promise((resolve, reject) => {
    execFile(
      launch.command,
      launch.args,
      { env, timeout: READ_TIMEOUT_MS, maxBuffer: 1024 * 1024, windowsHide: true },
      (error, stdout) => (stdout ? resolve(stdout) : reject(error ?? new Error('quota-axi printed nothing'))),
    );
  });

/**
 * Per-agent throttled reader. `publish` never throws and never blocks the
 * turn; at most one read runs at a time and one starts per interval.
 */
export class HarnessQuotaReader {
  private lastStartedAt = -Infinity;
  private running = false;

  constructor(
    private readonly options: {
      post: (usage: AgentUsage) => Promise<unknown>;
      run?: QuotaAxiRun;
      launch?: () => { command: string; args: string[] };
      now?: () => number;
      intervalMs?: number;
    },
  ) {}

  publish(provider: string | undefined, env: Record<string, string>): Promise<void> {
    const now = this.options.now?.() ?? Date.now();
    if (!provider || this.running || now - this.lastStartedAt < (this.options.intervalMs ?? QUOTA_READ_INTERVAL_MS))
      return Promise.resolve();
    // Turn-loop tests must never read the developer's real vendor quota.
    if (!this.options.run && process.env.VITEST) return Promise.resolve();
    this.lastStartedAt = now;
    this.running = true;
    return (async () => {
      const launch = (this.options.launch ?? quotaAxiLaunch)();
      const stdout = await (this.options.run ?? runQuotaAxi)(
        { command: launch.command, args: [...launch.args, '--provider', provider, '--json', '--no-credential-refresh'] },
        env,
      );
      const usage = quotaAxiUsage(JSON.parse(stdout), provider, now / 1000);
      if (usage) await this.options.post(usage);
    })()
      .catch((error) => console.error(`[agent-usage] quota-axi ${provider} read failed`, error instanceof Error ? error.message : error))
      .finally(() => {
        this.running = false;
      });
  }
}
