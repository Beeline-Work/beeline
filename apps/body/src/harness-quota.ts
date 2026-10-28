/**
 * Plan quota for every harness quota-axi can read (Claude, Codex, Cursor,
 * Grok, OpenCode Go). After a turn the helper runs the pinned quota-axi CLI in
 * the agent's own environment, so it reads that agent's own login, and turns
 * its report into the `AgentUsage` windows the owner's Profile shows.
 *
 * quota-axi never refreshes credentials here (`--no-credential-refresh`). It
 * prompts no keychain and spends no Claude inference, because neither
 * `--allow-keychain-prompt` nor `--allow-claude-inference` is ever passed. Its
 * output carries no token.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import {
  usageReason,
  type AgentUsage,
  type UsageRead,
  type UsageRefreshOutcome,
  type UsageWindow,
} from '@beeline/api-contract/daemon';
import type { AgentKind } from './agent-command.js';

/** Bundled next to `beeline-cli.mjs` by `scripts/build-beeline-bundle.mjs`. */
export const QUOTA_AXI_BUNDLE_FILE = 'quota-axi.mjs';
const READ_TIMEOUT_MS = 30_000;
/** One vendor read per plan account per interval keeps clear of usage-endpoint limits. */
export const QUOTA_READ_INTERVAL_MS = 5 * 60_000;
/** A refresh this soon after the last read shares that read instead of asking again. */
const REFRESH_REUSE_MS = 30_000;
/**
 * How many intervals a home may ride another home's read before it reads its
 * own login again, in case the login changed without its file changing.
 */
const ACCOUNT_REVERIFY_INTERVALS = 3;
const MAX_WINDOWS = 8;

/**
 * The quota-axi provider for a harness, or undefined when the agent bills
 * through OpenRouter (its key spend is read instead) or quota-axi has none.
 */
export function quotaAxiProvider(kind: AgentKind | undefined, openRouter: boolean): string | undefined {
  if (openRouter) return;
  switch (kind) {
    case 'claude':
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

/** quota-axi's provider state as the read Beeline shows; unknown states count as failed. */
function quotaAxiRead(state: Record<string, unknown> | undefined, at: number): UsageRead {
  const status = state?.status;
  const reason = usageReason(state?.error);
  const retryAfter = typeof state?.retryAfter === 'string' ? Date.parse(state.retryAfter) / 1000 : NaN;
  if (status === 'fresh' && state?.stale !== true) return { status: 'fresh', at };
  if (status === 'auth_required' || state?.reason === 'credentials_expired' || state?.authStatus === 'unusable')
    return { status: 'signed_out', at };
  if (status === 'rate_limited' || Number.isFinite(retryAfter))
    return { status: 'rate_limited', at, ...(Number.isFinite(retryAfter) ? { retryAfter } : {}) };
  if (status === 'stale') return { status: 'stale', at, ...(reason ? { reason } : {}) };
  return { status: 'failed', at, reason: reason ?? usageReason(status) ?? 'no reading' };
}

/**
 * One provider's quota-axi `--json` report as Beeline usage; unknown fields
 * are ignored. Windows carry the time the vendor answered (`refreshedAt` for
 * a cached or reused reading), and `read` says how this read went.
 */
export function quotaAxiUsage(
  report: unknown,
  provider: string,
  now = Date.now() / 1000,
): AgentUsage | undefined {
  const providers = record(report)?.providers;
  if (!Array.isArray(providers)) return;
  const entry = providers.map(record).find((p) => p?.provider === provider);
  if (!entry) return;
  const state = record(entry.state);
  const refreshedAt = typeof state?.refreshedAt === 'string' ? Date.parse(state.refreshedAt) / 1000 : NaN;
  const readAt = Number.isFinite(refreshedAt) ? Math.min(refreshedAt, now) : now;
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
      updatedAt: readAt,
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
  const read = quotaAxiRead(state, now);
  // A provider with nothing to show and nothing wrong is not reported.
  if (!windows.size && creditsLeft === undefined && read.status === 'fresh') return;
  const plan = typeof entry.plan === 'string' ? entry.plan.trim().slice(0, 40) : '';
  return {
    // Numbers carry when the vendor answered; a bare failure is stamped now.
    updatedAt: windows.size || creditsLeft !== undefined ? readAt : now,
    windows: [...windows.values()],
    ...(plan ? { plan } : {}),
    ...(creditsLeft !== undefined ? { credits: { remaining: creditsLeft } } : {}),
    read,
  };
}

const digest = (...parts: string[]) =>
  createHash('sha256').update(['beeline-usage-account-v1', ...parts].join('\0')).digest('hex').slice(0, 32);

/**
 * The plan account a report was read from, when the vendor verified it: a
 * hash of the account id and organization, so agents on one login share it
 * wherever their homes are. The id itself never leaves this process.
 */
export function quotaAxiAccountKey(report: unknown, provider: string): string | undefined {
  const providers = record(report)?.providers;
  if (!Array.isArray(providers)) return;
  const account = record(providers.map(record).find((p) => p?.provider === provider)?.account);
  if (account?.identityStatus !== 'verified' || typeof account.accountId !== 'string' || !account.accountId) return;
  return `id:${digest(provider, account.accountId, typeof account.organization === 'string' ? account.organization : '')}`;
}

/**
 * The credential file a provider reads in this environment, with links
 * resolved, so agents whose homes link one login share a read. Providers whose
 * store Beeline does not know return undefined and read per agent.
 */
export function quotaCredentialPath(provider: string, env: Record<string, string>): string | undefined {
  const home = env.HOME;
  const dir =
    provider === 'claude' ? (env.CLAUDE_CONFIG_DIR ?? (home && join(home, '.claude')))
      : provider === 'codex' ? (env.CODEX_HOME ?? (home && join(home, '.codex')))
        : undefined;
  if (!dir) return;
  const file = join(dir, provider === 'claude' ? '.credentials.json' : 'auth.json');
  try {
    return realpathSync(file);
  } catch {
    return file;
  }
}

/**
 * A cheap stamp of the credential file, so a new login (or a renewed token)
 * in that home is noticed without reading the vendor. Never reads the file.
 */
export function credentialFingerprint(path: string): string {
  try {
    const stat = statSync(path);
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  } catch {
    return 'missing';
  }
}

export type QuotaAxiRun = (
  launch: { command: string; args: string[] },
  env: Record<string, string>,
) => Promise<string>;

/**
 * The quota-axi flags; never add a refresh, keychain or inference opt-in here.
 * `--full` adds the verified account id that keys a shared plan; it makes no
 * extra vendor call.
 */
export function quotaAxiArgs(provider: string): string[] {
  return ['--provider', provider, '--json', '--full', '--no-credential-refresh'];
}

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

type ReadSlot = {
  lastStartedAt: number;
  running?: Promise<AgentUsage>;
  last?: AgentUsage;
  /** Each agent's post of the latest read, so it lands once per agent. */
  posts: Map<string, Promise<void>>;
  /** The account the last verified read named, for reads that cannot say. */
  accountKey?: string;
  /** When this home's own read last named `accountKey`, in ms. */
  verifiedAt?: number;
  /** The credential file's stamp when the last read started; a new stamp drops that read. */
  readLogin?: string;
};
/**
 * Every agent loop on this machine shares these slots, one per plan login:
 * agents whose homes link one credential file get one read per interval.
 * `account:<key>` names the slot that last read a verified account, so homes
 * with their own copy of one login share its reads too.
 */
const ACCOUNT_READ_SLOTS = new Map<string, ReadSlot>();

const outcomeOf = (usage: AgentUsage): UsageRefreshOutcome =>
  usage.read && usage.read.status !== 'fresh'
    ? {
        status: usage.read.status,
        ...(usage.read.reason ? { reason: usage.read.reason } : {}),
        ...(usage.read.retryAfter ? { retryAfter: usage.read.retryAfter } : {}),
      }
    : { status: 'fresh' };

/**
 * Whether a read from another home on `account` stands for this one too: same
 * verified account, and not a sign-in or reader failure that belongs to that
 * home alone.
 */
const sharesAccount = (usage: AgentUsage, account: string) =>
  usage.account?.key === account && usage.read?.status !== 'signed_out' && usage.read?.status !== 'failed';

/**
 * Throttled plan reader for one agent. `publish` never throws and never
 * blocks the turn. At most one read per login runs at a time and one starts
 * per interval; an agent that arrives while a read runs joins it, and an
 * agent throttled behind a sibling still gets that sibling's latest read.
 */
export class HarnessQuotaReader {
  constructor(
    private readonly options: {
      agentId: string;
      post: (usage: AgentUsage) => Promise<unknown>;
      slots?: Map<string, ReadSlot>;
      run?: QuotaAxiRun;
      launch?: () => { command: string; args: string[] };
      now?: () => number;
      intervalMs?: number;
      credentialPath?: (provider: string, env: Record<string, string>) => string | undefined;
      fingerprint?: (path: string) => string;
    },
  ) {}

  /** Read (or share a read) and post it; resolves with what the read found. */
  publish(
    provider: string | undefined,
    env: Record<string, string>,
    force = false,
  ): Promise<UsageRefreshOutcome | undefined> {
    return provider ? this.start(provider, env, force, true) : Promise.resolve(undefined);
  }

  private start(
    provider: string,
    env: Record<string, string>,
    force: boolean,
    shareAccount: boolean,
  ): Promise<UsageRefreshOutcome | undefined> {
    const now = this.options.now?.() ?? Date.now();
    const credential = (this.options.credentialPath ?? quotaCredentialPath)(provider, env);
    const login = `${provider}:${credential ?? `agent:${this.options.agentId}`}`;
    const slots = this.options.slots ?? ACCOUNT_READ_SLOTS;
    let slot = slots.get(login);
    if (!slot) slots.set(login, (slot = { lastStartedAt: -Infinity, posts: new Map() }));
    if (slot.running) return this.deliver(slot, slot.running);
    const fingerprint = credential ? (this.options.fingerprint ?? credentialFingerprint)(credential) : undefined;
    // The login in this home changed since its last read: forget that read,
    // its account and who it reached, so the next read is of the new login.
    if (slot.lastStartedAt > -Infinity && slot.readLogin !== fingerprint)
      Object.assign(slot, {
        lastStartedAt: -Infinity, last: undefined, posts: new Map(), accountKey: undefined, verifiedAt: undefined,
      });
    const intervalMs = this.options.intervalMs ?? QUOTA_READ_INTERVAL_MS;
    // A refresh, or a home that has not read itself for a while, reads its own
    // login rather than trust an account it named long ago.
    const verifiedFor = force ? intervalMs : intervalMs * ACCOUNT_REVERIFY_INTERVALS;
    const account = slot.accountKey && now - (slot.verifiedAt ?? -Infinity) < verifiedFor ? slot.accountKey : undefined;
    const sibling = shareAccount && account ? slots.get(`account:${account}`) : undefined;
    // Another home on this verified account is reading it now: join, unless
    // that read finds its login moved or its own sign-in broken.
    if (account && sibling && sibling !== slot && sibling.accountKey === account && sibling.running) {
      const running = sibling.running;
      return running.then((usage) =>
        sharesAccount(usage, account)
          ? this.deliver(sibling, running)
          : this.start(provider, env, force, false));
    }
    const latest = account && sibling && sibling.accountKey === account && sibling.lastStartedAt > slot.lastStartedAt
      && sibling.last && sharesAccount(sibling.last, account) ? sibling : slot;
    const since = now - latest.lastStartedAt;
    if (since < (force ? REFRESH_REUSE_MS : intervalMs))
      return latest.last ? this.deliver(latest, Promise.resolve(latest.last)) : Promise.resolve(undefined);
    // Turn-loop tests must never read the developer's real vendor quota.
    if (!this.options.run && process.env.VITEST) return Promise.resolve(undefined);
    const held = slot;
    held.lastStartedAt = now;
    held.readLogin = fingerprint;
    held.posts = new Map();
    if (account) slots.set(`account:${account}`, held);
    held.running = this.read(provider, env, held, login, now).finally(() => {
      held.running = undefined;
    });
    void held.running.then(() => {
      if (held.accountKey && held.accountKey !== account) slots.set(`account:${held.accountKey}`, held);
    });
    return this.deliver(held, held.running);
  }

  private async read(
    provider: string,
    env: Record<string, string>,
    slot: ReadSlot,
    login: string,
    nowMs: number,
  ): Promise<AgentUsage> {
    const now = nowMs / 1000;
    let usage: AgentUsage;
    try {
      const launch = (this.options.launch ?? quotaAxiLaunch)();
      const stdout = await (this.options.run ?? runQuotaAxi)(
        { command: launch.command, args: [...launch.args, ...quotaAxiArgs(provider)] },
        env,
      );
      const report: unknown = JSON.parse(stdout);
      const accountKey = quotaAxiAccountKey(report, provider);
      if (accountKey) Object.assign(slot, { accountKey, verifiedAt: nowMs });
      usage = quotaAxiUsage(report, provider, now) ?? {
        updatedAt: now, windows: [], read: { status: 'failed', at: now, reason: 'no plan numbers' },
      };
    } catch (error) {
      console.error(`[agent-usage] quota-axi ${provider} read failed`, error instanceof Error ? error.message : error);
      usage = { updatedAt: now, windows: [], read: { status: 'failed', at: now, reason: "usage reader didn't run" } };
    }
    // Without a verified account the read stays with this machine's login, so
    // two different accounts are never merged.
    const key = slot.accountKey ?? `local:${digest(hostname(), login)}`;
    slot.last = { ...usage, account: { provider, key } };
    return slot.last;
  }

  private async deliver(slot: ReadSlot, reading: Promise<AgentUsage>): Promise<UsageRefreshOutcome> {
    const usage = await reading;
    const agentId = this.options.agentId;
    let posted = slot.posts.get(agentId);
    if (!posted) {
      posted = this.options.post(usage).then(() => undefined);
      slot.posts.set(agentId, posted);
    }
    try {
      await posted;
    } catch (error) {
      if (slot.posts.get(agentId) === posted) slot.posts.delete(agentId);
      console.error('[agent-usage] quota post failed', error instanceof Error ? error.message : error);
      return { status: 'failed', reason: "couldn't save the read" };
    }
    return outcomeOf(usage);
  }
}
