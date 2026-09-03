/**
 * The command-kind grant runner (Agent Grants, slice 2).
 *
 * An approved `command` grant is a rule: the exact approved line is an argv
 * prefix the agent may say. `run_granted_command` reaches this runner from the
 * beeline-agent MCP server, which lives INSIDE the session sandbox; the runner
 * itself is the daemon, so the command runs outside bubblewrap as a plain child
 * process with cwd = the agent's Room checkout or corner worktree, an
 * environment of PATH and HOME plus only the secrets the rule names, a
 * ten-minute timeout, and capped output. Every run writes one ledger tool row
 * naming the grant and who asked. A `once` grant is spent before its first run
 * starts; a revoked rule is simply absent from the next `listAgentGrants` read,
 * so it stops matching immediately.
 *
 * Secrets are resolved from the operator key store (`provider-key-store.ts`,
 * `~/.config/beeline/providers.json`, addressed by the provider's env var name)
 * or from the saved-secrets file beside it (`secrets.json`, `{ NAME: value }`).
 * Values are injected into the child's env and scrubbed from its output; they
 * never reach the transcript, the ledger, or the model.
 */
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, resolve } from 'node:path';
import {
  commandGrantMatches,
  parseCommandGrantTarget,
  type CommandGrantRule,
} from '@beeline/api-contract/agent-grants';
import type { DaemonOperationMap } from '@beeline/api-contract/daemon';
import type { DaemonApiClient } from './daemon-api-client.js';
import {
  PROVIDER_KEY_ENV_VARS,
  providerKeyStorePath,
  readProviderKeyStore,
  type ProviderKeyProvider,
} from './provider-key-store.js';

export const GRANT_COMMAND_TIMEOUT_MS = 10 * 60_000;
export const GRANT_COMMAND_OUTPUT_CAP_BYTES = 64 * 1024;
const ARGV_MAX_WORDS = 256;
const ARGV_WORD_MAX_LENGTH = 4_096;

type LiveGrant = DaemonOperationMap['listAgentGrants']['output']['grants'][number];

export type GrantRunRequester = { pubkey: string; name?: string };

/** What a serving Room registers so the runner knows where and for whom it runs. */
export interface GrantRunnerRoom {
  workspaceId: string;
  cwd: string;
  /** The turn in flight, if any: its request id and the identity whose message started it. */
  turn: () => { requestId: string; requester?: GrantRunRequester } | undefined;
}

export interface GrantRunResult {
  grantId: string;
  exitCode: number | null;
  signal?: string;
  timedOut: boolean;
  output: string;
}

export type SecretResolver = (name: string) => Promise<string | undefined>;

/** Resolve one named secret from the operator key store, never echoing it. */
export function operatorSecretResolver(env: NodeJS.ProcessEnv = process.env): SecretResolver {
  const providerByEnvVar = new Map(
    (Object.entries(PROVIDER_KEY_ENV_VARS) as [ProviderKeyProvider, string][]).map(
      ([provider, envVar]) => [envVar, provider],
    ),
  );
  return async (name) => {
    const provider = providerByEnvVar.get(name);
    if (provider) {
      const saved = (await readProviderKeyStore(env))[provider];
      if (saved) return saved;
    }
    const raw = await readFile(resolve(dirname(providerKeyStorePath(env)), 'secrets.json'), 'utf8').catch(
      () => undefined,
    );
    if (!raw) return undefined;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
      const value = (parsed as Record<string, unknown>)[name];
      return typeof value === 'string' && value.length > 0 ? value : undefined;
    } catch {
      return undefined;
    }
  };
}

export function validateGrantArgv(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('argv must be a non-empty array');
  if (value.length > ARGV_MAX_WORDS) throw new Error(`argv exceeds ${ARGV_MAX_WORDS} words`);
  return value.map((word) => {
    if (typeof word !== 'string' || !word) throw new Error('argv words must be non-empty strings');
    if (word.length > ARGV_WORD_MAX_LENGTH || /[\0\r\n]/.test(word)) {
      throw new Error('argv words must be single-line and bounded');
    }
    return word;
  });
}

/** Pick the rule that matches: the approved argv is a word-for-word prefix of the request. */
export function matchCommandGrant(
  grants: readonly LiveGrant[],
  workspaceId: string,
  argv: readonly string[],
): { grant: LiveGrant; rule: CommandGrantRule } | undefined {
  for (const grant of grants) {
    if (grant.kind !== 'command' || grant.workspaceId !== workspaceId) continue;
    let rule: CommandGrantRule;
    try {
      rule = parseCommandGrantTarget(grant.target);
    } catch {
      continue;
    }
    if (commandGrantMatches(rule, argv)) return { grant, rule };
  }
  return undefined;
}

function capOutput(value: string, cap: number): string {
  if (Buffer.byteLength(value) <= cap) return value;
  const half = Math.floor(cap / 2);
  const bytes = Buffer.from(value);
  return `${bytes.subarray(0, half).toString('utf8')}\n…[${bytes.length - cap} bytes omitted]…\n${bytes
    .subarray(bytes.length - half)
    .toString('utf8')}`;
}

function scrubSecrets(value: string, secrets: ReadonlyMap<string, string>): string {
  let scrubbed = value;
  for (const [name, secret] of secrets) {
    if (secret.length >= 4) scrubbed = scrubbed.split(secret).join(`[${name}]`);
  }
  return scrubbed;
}

export interface GrantCommandRunnerOptions {
  api: Pick<DaemonApiClient, 'execute'>;
  agentId: string;
  resolveSecret?: SecretResolver;
  /** Source of PATH and HOME for the child; everything else is dropped. */
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  outputCapBytes?: number;
}

export class GrantCommandRunner {
  private readonly rooms = new Map<string, GrantRunnerRoom>();
  private readonly resolveSecret: SecretResolver;

  constructor(private readonly options: GrantCommandRunnerOptions) {
    this.resolveSecret = options.resolveSecret ?? operatorSecretResolver(options.env ?? process.env);
  }

  register(roomId: string, room: GrantRunnerRoom): void {
    this.rooms.set(roomId, room);
  }

  unregister(roomId: string): void {
    this.rooms.delete(roomId);
  }

  async run(input: { roomId: unknown; argv: unknown }): Promise<GrantRunResult> {
    if (typeof input.roomId !== 'string' || !input.roomId) throw new Error('roomId is required');
    const room = this.rooms.get(input.roomId);
    if (!room) throw new Error('this daemon is not serving that Room');
    const argv = validateGrantArgv(input.argv);
    const live = await this.options.api.execute('listAgentGrants', { agentId: this.options.agentId });
    const match = matchCommandGrant(live.grants, room.workspaceId, argv);
    if (!match) {
      throw new Error(
        `no approved command grant matches: ${argv.join(' ')}. Ask with request_grant kind=command first.`,
      );
    }
    const { grant, rule } = match;
    const secrets = new Map<string, string>();
    for (const name of rule.secrets) {
      const value = await this.resolveSecret(name);
      if (!value) throw new Error(`secret ${name} is not in the operator key store`);
      secrets.set(name, value);
    }
    // A once grant is spent before the command starts, so a second call in the
    // same instant cannot ride the same approval.
    if (grant.status === 'once') {
      await this.options.api.execute('consumeAgentGrant', { grantId: grant.grantId });
    }
    const source = this.options.env ?? process.env;
    const env: Record<string, string> = {
      ...(source.PATH ? { PATH: source.PATH } : {}),
      ...(source.HOME ? { HOME: source.HOME } : {}),
      ...Object.fromEntries(secrets),
    };
    const cap = this.options.outputCapBytes ?? GRANT_COMMAND_OUTPUT_CAP_BYTES;
    const outcome = await new Promise<{
      exitCode: number | null;
      signal?: string;
      timedOut: boolean;
      output: string;
    }>((resolveRun) => {
      const child = execFile(
        argv[0]!,
        argv.slice(1),
        {
          cwd: room.cwd,
          env,
          timeout: this.options.timeoutMs ?? GRANT_COMMAND_TIMEOUT_MS,
          killSignal: 'SIGKILL',
          maxBuffer: cap * 4,
          encoding: 'utf8',
        },
        (error, stdout, stderr) => {
          const combined = [stdout, stderr].filter(Boolean).join(stderr && stdout ? '\n' : '');
          const failure = error as (NodeJS.ErrnoException & { killed?: boolean; signal?: string }) | null;
          const spawnFailure = Boolean(failure && typeof failure.code === 'string');
          resolveRun({
            exitCode: spawnFailure
              ? null
              : (child.exitCode ?? (typeof failure?.code === 'number' ? failure.code : 0)),
            ...(failure?.signal ? { signal: failure.signal } : {}),
            timedOut: Boolean(failure?.killed && failure?.signal === 'SIGKILL'),
            output: spawnFailure ? `${combined}${combined ? '\n' : ''}${failure!.message}` : combined,
          });
        },
      );
    });
    const output = capOutput(scrubSecrets(outcome.output, secrets), cap);
    const turn = room.turn();
    const requester = turn?.requester ?? {
      pubkey: grant.requestedBy,
      ...(grant.requestedByName ? { name: grant.requestedByName } : {}),
    };
    const status = outcome.timedOut
      ? 'timed out'
      : outcome.exitCode === null
        ? 'error'
        : `exit ${outcome.exitCode}`;
    await this.options.api.execute('postAgentActivity', {
      agentId: this.options.agentId,
      roomId: input.roomId,
      requestId: turn?.requestId ?? `grant:${grant.grantId}`,
      activity: [
        {
          kind: 'tool',
          title: `ran ${argv.join(' ')} under grant ${grant.grantId} · asked by ${
            requester.name ?? requester.pubkey.slice(0, 12)
          }`,
          operation: 'execute',
          status,
          command: argv.join(' '),
          ...(output ? { output } : {}),
          requestedBy: requester,
        },
      ],
    });
    return {
      grantId: grant.grantId,
      exitCode: outcome.exitCode,
      ...(outcome.signal ? { signal: outcome.signal } : {}),
      timedOut: outcome.timedOut,
      output,
    };
  }
}

export interface GrantRunnerEndpoint {
  url: string;
  token: string;
}

/**
 * The loopback door the in-sandbox MCP server knocks on. bubblewrap shares the
 * network namespace (see `bwrap-sandbox.ts`), so 127.0.0.1 reaches the daemon;
 * a per-process random bearer token keeps other local users out.
 */
export class GrantRunnerServer {
  private server?: Server;
  private endpoint?: GrantRunnerEndpoint;

  constructor(private readonly runner: GrantCommandRunner) {}

  async start(): Promise<GrantRunnerEndpoint> {
    if (this.endpoint) return this.endpoint;
    const token = randomBytes(32).toString('base64url');
    const server = createServer((request, response) => {
      void this.handle(request, response, token);
    });
    await new Promise<void>((resolveListen, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolveListen());
    });
    server.unref?.();
    const address = server.address() as AddressInfo;
    this.server = server;
    this.endpoint = { url: `http://127.0.0.1:${address.port}`, token };
    return this.endpoint;
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.endpoint = undefined;
    if (!server) return;
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }

  private async handle(
    request: import('node:http').IncomingMessage,
    response: import('node:http').ServerResponse,
    token: string,
  ): Promise<void> {
    const send = (status: number, body: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    if (request.headers.authorization !== `Bearer ${token}`) {
      send(401, { error: 'grant runner token required' });
      return;
    }
    if (request.method !== 'POST' || request.url !== '/run') {
      send(404, { error: 'not found' });
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        roomId?: unknown;
        argv?: unknown;
      };
      send(200, await this.runner.run({ roomId: body.roomId, argv: body.argv }));
    } catch (error) {
      send(400, { error: error instanceof Error ? error.message : String(error) });
    }
  }
}
