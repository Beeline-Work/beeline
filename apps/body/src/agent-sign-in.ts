/**
 * `@agent login` on the agent's own machine: one dispatcher, four kinds.
 *
 * - paste-code (Claude Code): `claude-sign-in.ts` builds the PKCE link and
 *   exchanges the pasted code.
 * - device-code (Codex, Grok) and approve-wait (Cursor): this helper runs the
 *   harness's own headless login, reads the link (and code) it prints, and
 *   reports the result when that process ends. The CLI keeps its own session
 *   and writes its own login file under the operator's home, the file every
 *   Room's isolated home links to (`agent-home.ts` SHARED_CREDENTIALS).
 * - api-key (Pi, Goose, OpenCode): the pasted key is verified with the
 *   provider (`provider-key-check.ts`, as `beeline connect` does) and written
 *   where that harness reads it.
 *
 * The CLI output shapes below were read from the real CLIs (Codex 0.160.0,
 * Grok 1.0.46, Cursor Agent 2026.10.01-e373342); `agent-sign-in.contract.test.ts`
 * pins them. Nothing here logs a code, key, or token.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  AGENT_SIGN_IN_ATTEMPT_TTL_MS,
  AGENT_SIGN_IN_PROVIDER_LABELS,
  isAgentSignInHarness,
  type AgentSignInFrame,
  type AgentSignInHarness,
  type AgentSignInKeyProvider,
  type AgentSignInLink,
  type ReportAgentSignInInput,
} from '@beeline/api-contract/daemon';
import { readJsonObject, writePrivateFileAtomically } from './atomic-private-file.js';
import { ClaudeSignIn } from './claude-sign-in.js';
import type { DaemonApiClient } from './daemon-api-client.js';
import { verifyProviderKey } from './provider-key-check.js';

/** How long the CLI may take to print its link before the attempt fails. */
const CLI_LINK_TIMEOUT_MS = 30_000;

export type CliSignIn = {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly kind: 'device-code' | 'approve-wait';
  /** Read the accumulated output; undefined until everything the card needs is printed. */
  readonly parse: (output: string, now: number) => AgentSignInLink | undefined;
};

/** `codex login --device-auth` (Codex 0.160.0). */
export function parseCodexDeviceLogin(output: string, now: number): AgentSignInLink | undefined {
  const url = /Open this link[^\n]*\n\s*(https:\/\/\S+)/.exec(output)?.[1];
  const code = /Enter this one-time code[^\n]*\n\s*([A-Z0-9]{4}-[A-Z0-9]{4,6})\s*$/m.exec(output)?.[1];
  if (!url || !code) return undefined;
  const minutes = Number(/expires in (\d+) minutes/.exec(output)?.[1] ?? 15);
  return { kind: 'device-code', authorizeUrl: url, userCode: code, expiresAt: now + minutes * 60_000 };
}

/** `grok login --device-auth` (Grok 1.0.46). */
export function parseGrokDeviceLogin(output: string, now: number): AgentSignInLink | undefined {
  const url = /open this URL in your browser:\s*\n\s*(https:\/\/\S+)/.exec(output)?.[1];
  const code = /Confirm this code in your browser:\s*\n\s*([A-Z0-9]{4}-[A-Z0-9]{4,6})\s*$/m.exec(output)?.[1];
  if (!url || !code) return undefined;
  return {
    kind: 'device-code',
    authorizeUrl: url,
    userCode: code,
    expiresAt: now + AGENT_SIGN_IN_ATTEMPT_TTL_MS,
  };
}

/** `NO_OPEN_BROWSER=1 cursor-agent login` (Cursor Agent 2026.10.01-e373342). */
export function parseCursorLogin(output: string): AgentSignInLink | undefined {
  const url = /navigate to this link:\s*(https:\/\/\S+)/.exec(output)?.[1];
  return url ? { kind: 'approve-wait', authorizeUrl: url } : undefined;
}

export const CLI_SIGN_INS: Readonly<Record<'codex' | 'grok' | 'cursor', CliSignIn>> = {
  codex: {
    command: 'codex',
    args: ['login', '--device-auth'],
    env: {},
    kind: 'device-code',
    parse: parseCodexDeviceLogin,
  },
  grok: {
    command: 'grok',
    args: ['login', '--device-auth'],
    env: {},
    kind: 'device-code',
    parse: parseGrokDeviceLogin,
  },
  cursor: {
    command: 'cursor-agent',
    args: ['login'],
    env: { NO_OPEN_BROWSER: '1' },
    kind: 'approve-wait',
    parse: (output) => parseCursorLogin(output),
  },
};

/** The environment variable a Pi or Goose agent reads each provider's key from. */
export const PROVIDER_KEY_ENV: Readonly<Record<AgentSignInKeyProvider, string>> = {
  openrouter: 'OPENROUTER_API_KEY',
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  google: 'GEMINI_API_KEY',
  xai: 'XAI_API_KEY',
};

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
/** Variables that point a harness at an isolated home; a login must land in the operator's. */
const ISOLATION_VARIABLES = ['CODEX_HOME', 'GROK_HOME', 'CURSOR_HOME', 'CLAUDE_CONFIG_DIR'];

function lastLine(output: string): string {
  const lines = output.replace(ANSI, '').split('\n').map((line) => line.trim()).filter(Boolean);
  return (lines.at(-1) ?? '').slice(0, 200);
}

/** Which provider a Pi or Goose agent was connected with, read from its env file. */
export async function keyProviderFromEnvFile(
  llmEnvFile: string | undefined,
): Promise<AgentSignInKeyProvider | undefined> {
  if (!llmEnvFile) return undefined;
  const text = await readFile(llmEnvFile, 'utf8').catch(() => '');
  const goose = /^GOOSE_PROVIDER=("?)([a-z]+)\1\s*$/m.exec(text)?.[2];
  const providers = Object.keys(PROVIDER_KEY_ENV) as AgentSignInKeyProvider[];
  if (goose && providers.includes(goose as AgentSignInKeyProvider))
    return goose as AgentSignInKeyProvider;
  return providers.find((provider) =>
    new RegExp(`^${PROVIDER_KEY_ENV[provider]}=`, 'm').test(text),
  );
}

/** Replace one `KEY=value` line of an env file atomically, keeping every other line. */
export async function writeEnvFileKey(path: string, name: string, value: string): Promise<void> {
  const text = await readFile(path, 'utf8').catch(() => '');
  const line = `${name}=${JSON.stringify(value)}`;
  const lines = text.split('\n').filter((entry, index, all) => entry || index < all.length - 1);
  const at = lines.findIndex((entry) => entry.startsWith(`${name}=`));
  if (at >= 0) lines[at] = line;
  else lines.push(line);
  await writePrivateFileAtomically(path, `${lines.filter(Boolean).join('\n')}\n`);
}

/** Merge one provider key into OpenCode's own credential store. */
export async function writeOpenCodeKey(
  operatorHome: string,
  provider: AgentSignInKeyProvider,
  key: string,
): Promise<string> {
  const path = join(operatorHome, '.local', 'share', 'opencode', 'auth.json');
  const next = { ...(await readJsonObject(path)), [provider]: { type: 'api', key } };
  await writePrivateFileAtomically(path, `${JSON.stringify(next, null, 2)}\n`);
  return path;
}

export type AgentSignInOptions = {
  readonly harness: AgentSignInHarness;
  readonly operatorHome: string;
  /** The live agent env (shared with session spawn); a saved key is applied to it. */
  readonly agentEnv: Record<string, string>;
  /** The Pi/Goose provider env file `beeline connect` wrote. */
  readonly llmEnvFile?: string;
  /** The model the agent runs, `provider/model` for OpenCode. */
  readonly model?: () => string | undefined;
  /** A result that arrives on its own, after `start` answered. */
  readonly onResult: (attemptId: string, result: { ok: true } | { ok: false; error: string }) => void;
  /** After a key is saved: retire idle sessions so the next turn uses it. */
  readonly onKeySaved?: () => void;
  readonly spawn?: typeof spawn;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
};

type Pending =
  | { readonly kind: 'cli'; readonly child: ChildProcess; readonly timer: NodeJS.Timeout }
  | { readonly kind: 'key'; readonly provider: AgentSignInKeyProvider; readonly expiresAt: number };

/** One agent runtime's sign-in attempts. Secrets never leave this process. */
export class AgentSignIn {
  readonly #claude: ClaudeSignIn;
  readonly #pending = new Map<string, Pending>();
  readonly #spawn: typeof spawn;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;

  constructor(private readonly options: AgentSignInOptions) {
    this.#spawn = options.spawn ?? spawn;
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? Date.now;
    this.#claude = new ClaudeSignIn({
      operatorHome: options.operatorHome,
      fetch: this.#fetch,
      now: this.#now,
    });
  }

  async start(attemptId: string): Promise<AgentSignInLink> {
    const { harness } = this.options;
    if (harness === 'claude')
      return { kind: 'paste-code', authorizeUrl: this.#claude.start(attemptId) };
    if (harness === 'codex' || harness === 'grok' || harness === 'cursor')
      return this.#startCli(attemptId, CLI_SIGN_INS[harness]);
    return this.#startKey(attemptId);
  }

  /** A pasted code (Claude) or key (Pi, Goose, OpenCode). */
  async submit(attemptId: string, value: string): Promise<void> {
    if (this.options.harness === 'claude') return this.#claude.complete(attemptId, value);
    const pending = this.#pending.get(attemptId);
    if (!pending || pending.kind !== 'key' || pending.expiresAt <= this.#now())
      throw new Error("This sign-in expired or was already used. Send the agent `login` again to start a new one.");
    await this.#saveKey(pending.provider, value.trim());
    this.#pending.delete(attemptId);
  }

  /** Stop every CLI login this runtime started (runtime shutdown). */
  stop(): void {
    for (const [attemptId, pending] of this.#pending) {
      this.#pending.delete(attemptId);
      if (pending.kind === 'cli') {
        clearTimeout(pending.timer);
        pending.child.kill('SIGTERM');
      }
    }
  }

  #startCli(attemptId: string, login: CliSignIn): Promise<AgentSignInLink> {
    // One headless login at a time: a new `login` replaces an unfinished one.
    for (const [id, pending] of this.#pending) {
      if (pending.kind !== 'cli') continue;
      this.#pending.delete(id);
      clearTimeout(pending.timer);
      pending.child.kill('SIGTERM');
    }
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: this.options.operatorHome,
      PATH: this.options.agentEnv.PATH || process.env.PATH || '',
      ...login.env,
    };
    for (const name of ISOLATION_VARIABLES) delete env[name];
    return new Promise((resolve, reject) => {
      let output = '';
      let answered = false;
      let child: ChildProcess;
      try {
        child = this.#spawn(login.command, [...login.args], {
          env,
          cwd: this.options.operatorHome,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch {
        reject(new Error(`\`${login.command}\` is not installed on the agent's machine.`));
        return;
      }
      const linkTimer = setTimeout(() => {
        if (answered) return;
        answered = true;
        child.kill('SIGTERM');
        reject(new Error(`\`${login.command} ${login.args.join(' ')}\` printed no sign-in link. Update it on the agent's machine, then try again.`));
      }, CLI_LINK_TIMEOUT_MS);
      linkTimer.unref?.();
      const expiry = setTimeout(() => {
        this.#pending.delete(attemptId);
        child.kill('SIGTERM');
        this.options.onResult(attemptId, {
          ok: false,
          error: 'The sign-in expired before it was approved. Send the agent `login` again.',
        });
      }, AGENT_SIGN_IN_ATTEMPT_TTL_MS);
      expiry.unref?.();
      this.#pending.set(attemptId, { kind: 'cli', child, timer: expiry });
      const read = (chunk: Buffer) => {
        output = `${output}${chunk.toString('utf8')}`.slice(-16_000);
        if (answered) return;
        const link = login.parse(output.replace(ANSI, '').replace(/\r/g, ''), this.#now());
        if (!link) return;
        answered = true;
        clearTimeout(linkTimer);
        resolve(link);
      };
      child.stdout?.on('data', read);
      child.stderr?.on('data', read);
      child.once('error', (error) => {
        clearTimeout(linkTimer);
        clearTimeout(expiry);
        this.#pending.delete(attemptId);
        const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
        const message = missing
          ? `\`${login.command}\` is not installed on the agent's machine.`
          : `\`${login.command}\` could not start: ${error.message}`;
        if (!answered) {
          answered = true;
          reject(new Error(message));
        }
      });
      child.once('exit', (code, signal) => {
        clearTimeout(linkTimer);
        clearTimeout(expiry);
        const owned = this.#pending.get(attemptId);
        if (owned?.kind === 'cli' && owned.child === child) this.#pending.delete(attemptId);
        else return; // replaced, expired, or stopped: its outcome is already decided
        const failure = `\`${login.command} login\` stopped: ${lastLine(output) || (signal ?? `exit ${code}`)}`;
        if (!answered) {
          answered = true;
          reject(new Error(failure));
          return;
        }
        this.options.onResult(attemptId, code === 0 ? { ok: true } : { ok: false, error: failure });
      });
    });
  }

  async #startKey(attemptId: string): Promise<AgentSignInLink> {
    const { harness } = this.options;
    let provider: AgentSignInKeyProvider | undefined;
    if (harness === 'opencode') {
      const prefix = this.options.model?.()?.split('/')[0];
      provider = prefix && prefix in PROVIDER_KEY_ENV ? (prefix as AgentSignInKeyProvider) : undefined;
      if (!provider)
        throw new Error(
          "This OpenCode agent's model is not served by a provider key Beeline can set. Run `opencode auth login` on its machine.",
        );
    } else {
      provider = await keyProviderFromEnvFile(this.options.llmEnvFile);
      if (!provider)
        throw new Error(
          'This agent has no provider key to replace. Run `beeline connect` on its machine.',
        );
    }
    this.#pending.set(attemptId, {
      kind: 'key',
      provider,
      expiresAt: this.#now() + AGENT_SIGN_IN_ATTEMPT_TTL_MS,
    });
    return { kind: 'api-key', provider };
  }

  async #saveKey(provider: AgentSignInKeyProvider, key: string): Promise<void> {
    if (!key) throw new Error(`Paste the ${AGENT_SIGN_IN_PROVIDER_LABELS[provider]} key.`);
    await verifyProviderKey({ provider, apiKey: key, fetchImpl: this.#fetch });
    if (this.options.harness === 'opencode') {
      await writeOpenCodeKey(this.options.operatorHome, provider, key);
    } else {
      if (!this.options.llmEnvFile)
        throw new Error('This agent has no provider key to replace. Run `beeline connect` on its machine.');
      await writeEnvFileKey(this.options.llmEnvFile, PROVIDER_KEY_ENV[provider], key);
      this.options.agentEnv[PROVIDER_KEY_ENV[provider]] = key;
    }
    this.options.onKeySaved?.();
  }
}

/** Validate one live frame from the server; anything else is ignored. */
export function agentSignInFrame(event: Record<string, unknown>): AgentSignInFrame | undefined {
  if (event.type !== 'agent-sign-in' || typeof event.attemptId !== 'string' || !event.attemptId)
    return undefined;
  if (event.step === 'start' && typeof event.cardId === 'string' && event.cardId)
    return { type: 'agent-sign-in', step: 'start', attemptId: event.attemptId, cardId: event.cardId };
  if (event.step === 'code' && typeof event.code === 'string')
    return { type: 'agent-sign-in', step: 'code', attemptId: event.attemptId, code: event.code };
  return undefined;
}

/** The harness an agent runtime signs in with, or undefined when Beeline cannot. */
export function agentSignInHarness(kind: string): AgentSignInHarness | undefined {
  return isAgentSignInHarness(kind) ? kind : undefined;
}

/**
 * Run one frame and report its answer. Logs name the attempt and the error,
 * never the code, key, verifier, or token.
 */
export async function answerAgentSignInFrame(
  api: Pick<DaemonApiClient, 'execute'>,
  agentId: string,
  signIn: Pick<AgentSignIn, 'start' | 'submit'>,
  frame: AgentSignInFrame,
  cards: Map<string, string>,
  log: (message: string) => void = () => {},
): Promise<void> {
  let report: ReportAgentSignInInput;
  try {
    if (frame.step === 'start') {
      cards.set(frame.attemptId, frame.cardId);
      report = { agentId, attemptId: frame.attemptId, ...(await signIn.start(frame.attemptId)) };
    } else {
      await signIn.submit(frame.attemptId, frame.code);
      const cardId = cards.get(frame.attemptId);
      report = { agentId, attemptId: frame.attemptId, ...(cardId ? { cardId } : {}), outcome: 'signed-in' };
      log(`sign-in ${frame.attemptId} saved`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`sign-in ${frame.attemptId} ${frame.step} failed: ${message}`);
    const cardId = cards.get(frame.attemptId);
    report = {
      agentId,
      attemptId: frame.attemptId,
      ...(cardId ? { cardId } : {}),
      outcome: 'failed',
      error: message,
    };
  }
  try {
    await api.execute('reportAgentSignIn', report);
  } catch (error) {
    log(
      `sign-in ${frame.attemptId} report failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Report a result that arrived on its own (a device code approved, a login that expired). */
export async function reportAgentSignInResult(
  api: Pick<DaemonApiClient, 'execute'>,
  agentId: string,
  attemptId: string,
  cards: Map<string, string>,
  result: { ok: true } | { ok: false; error: string },
  log: (message: string) => void = () => {},
): Promise<void> {
  const cardId = cards.get(attemptId);
  const report: ReportAgentSignInInput = result.ok
    ? { agentId, attemptId, ...(cardId ? { cardId } : {}), outcome: 'signed-in' }
    : { agentId, attemptId, ...(cardId ? { cardId } : {}), outcome: 'failed', error: result.error };
  log(`sign-in ${attemptId} ${result.ok ? 'finished' : `failed: ${result.error}`}`);
  try {
    await api.execute('reportAgentSignIn', report);
  } catch (error) {
    log(`sign-in ${attemptId} report failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
