/**
 * The command-kind grant runner (Agent Grants, slice 2).
 *
 * An approved `command` grant is a rule: the exact approved line is an argv
 * prefix the agent may say. `run_granted_command` reaches this runner from the
 * beeline-agent MCP server, which lives INSIDE the session sandbox; the runner
 * itself is the daemon, so it spawns the command as its own child, with cwd =
 * the agent's Room checkout or corner worktree, an environment of PATH and HOME
 * plus only the secrets the rule names, a ten-minute timeout, and capped output.
 *
 * ## The capability table decides where it runs (C94)
 *
 * `@beeline/api-contract/surface-capabilities` holds one row per capability and
 * the standing invariant that a corner may do everything a Room may. A grant
 * used to invert it: the runner spawned unwrapped with the operator's live
 * project as cwd, so a Room was the more powerful surface for host work while a
 * corner could only touch its worktree.
 *
 * Now the surface decides. A corner has `run-host-command`, so a corner grant
 * spawns as a plain child and may act on the live host — that is the point, and
 * under yolo it just runs. A Room does not, so a Room grant is spawned into the
 * SAME read-only mount table an ordinary Room session gets (`bwrap-sandbox.ts`,
 * `mode: 'readonly'`): the whole host readable, and writable only in the
 * session's own scratch and harness home overlay, exactly as today. The refusal
 * comes from the kernel, not from a guess about what the argv means.
 *
 * Fail-CLOSED, deliberately: with no usable bubblewrap on the host there is no
 * way to keep a Room's promise, so a Room grant is refused outright and the
 * agent is told to open a corner. That is the opposite of the harness spawn
 * path, which fails open so a host without bwrap can still hold a conversation.
 *
 * Two hard stops survive yolo on both surfaces and are re-checked here as well
 * as at request time: a credential or environment file named by words the
 * approved prefix never showed a human, and a script nobody has read. An
 * interpreter grant is bound to the script bytes the approval card showed: the
 * file is re-hashed before every run, and a script that changed, or one that
 * appeared where the card had none, is refused.
 *
 * Every run writes one ledger tool row naming the grant and who asked. A `once`
 * grant is spent before its first run starts; a revoked rule is simply absent from the next `listAgentGrants` read,
 * so it stops matching immediately.
 *
 * Secrets are resolved from the operator key store (`provider-key-store.ts`,
 * `~/.config/beeline/providers.json`, addressed by the provider's env var name)
 * or from the saved-secrets file beside it (`secrets.json`, `{ NAME: value }`).
 * Values are injected into the child's env and scrubbed from its output; they
 * never reach the transcript, the ledger, or the model.
 */
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, resolve } from 'node:path';
import {
  commandGrantEscalationsBeyondRule,
  commandGrantMatches,
  formatGrantEscalationReason,
  interpreterScriptArgument,
  parseCommandGrantTarget,
  type CommandGrantRule,
} from '@beeline/api-contract/agent-grants';
import type { DaemonOperationMap } from '@beeline/api-contract/daemon';
import {
  surfaceAllows,
  type AgentSurface,
} from '@beeline/api-contract/surface-capabilities';
import { wrapAgentCommand, type MaskedPath } from './bwrap-sandbox.js';
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

/**
 * The surface a granted command runs on, plus what its session made writable.
 * `surfaceAllows(surface, 'run-host-command')` decides whether the command is
 * spawned plainly or into the Room's read-only mount table.
 */
export interface GrantWritePolicy {
  surface: AgentSurface;
  /** The self-tested bwrap; absent on a Room means its promise cannot be kept. */
  bwrapPath?: string;
  /** The session's TMPDIR, writable on both surfaces and where a script may live. */
  scratch?: string;
  /** The `agent-home.ts` overlay this session writes into; stays writable in a Room. */
  harnessStateDirs?: string[];
  /** Credential stores hidden from the run, exactly as a Room session hides them. */
  maskPaths?: MaskedPath[];
}

/** What a serving Room registers so the runner knows where and for whom it runs. */
export interface GrantRunnerRoom {
  workspaceId: string;
  cwd: string;
  /** Read at each run, because a Room's scratch is only known once its session starts. */
  writePolicy: () => GrantWritePolicy;
  /** The turn in flight, if any: its request id and the identity whose message started it. */
  turn: () => { requestId: string; requester?: GrantRunRequester } | undefined;
}

export interface GrantRunResult {
  grantId: string;
  exitCode: number | null;
  signal?: string;
  timedOut: boolean;
  output: string;
  /** True when the read-only Room filesystem refused a write this command tried. */
  writeRefused?: boolean;
}

/** The kernel's own words when the read-only bind refuses a write. */
const WRITE_REFUSED = /Read-only file system|EROFS/;

export const ROOM_SANDBOX_UNAVAILABLE =
  'this Room cannot run granted commands: a Room promises a read-only filesystem and that ' +
  'promise is enforced by bubblewrap, which is not usable on this host. Open a corner with ' +
  'open_corner and run it there, where writes belong.';

export const ROOM_WRITE_REFUSED_NOTE =
  '[beeline] the Room filesystem is read-only outside your scratch directory, so this write ' +
  'was refused by the kernel. Open a corner with open_corner to change files.';

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
    // The rule is an argv PREFIX, so a run can always add words the human who
    // answered the card never read. Anything those words escalate into is a
    // fresh ask (C94).
    const beyond = commandGrantEscalationsBeyondRule(rule, argv);
    if (beyond.length) {
      throw new Error(
        `this run needs its own approval: ${formatGrantEscalationReason(beyond)}. ` +
          'Ask with request_grant kind=command for the exact line so a human can read it.',
      );
    }
    // Read once: the scratch directory is part of where a script may live, and
    // the mount table below is built from the same answer.
    const policy = room.writePolicy();
    await this.checkScriptBinding(grant, scriptCandidates(room.cwd, policy.scratch, argv), argv);
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
    // The capability table decides: a corner may act on the host, so it spawns
    // plainly; a Room may not, so it spawns into the very mount table an
    // ordinary Room session gets — whole host readable, writable only in its own
    // scratch and home overlay.
    const spawn = surfaceAllows(policy.surface, 'run-host-command')
      ? { command: argv[0]!, args: argv.slice(1) }
      : roomSandboxCommand(policy, room.cwd, argv);
    const outcome = await new Promise<{
      exitCode: number | null;
      signal?: string;
      timedOut: boolean;
      output: string;
    }>((resolveRun) => {
      const child = execFile(
        spawn.command,
        spawn.args,
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
    // The record says what happened: a refused write is the Room boundary doing
    // its job, and the agent is told where the work belongs instead.
    const writeRefused =
      !surfaceAllows(policy.surface, 'run-host-command') && WRITE_REFUSED.test(outcome.output);
    const output = capOutput(
      scrubSecrets(
        writeRefused ? `${outcome.output.trimEnd()}\n${ROOM_WRITE_REFUSED_NOTE}` : outcome.output,
        secrets,
      ),
      cap,
    );
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
      ...(writeRefused ? { writeRefused: true } : {}),
    };
  }

  /**
   * An interpreter grant may only run the bytes the approval card showed.
   *
   * The file is re-read and re-hashed here, immediately before the run: a
   * script the agent rewrote after the human answered no longer matches, and a
   * script that appeared where the card had none was never approved at all. A
   * line with no such file (`python3 -V`) has nothing to bind and passes.
   */
  private async checkScriptBinding(
    grant: LiveGrant,
    candidates: readonly string[],
    argv: readonly string[],
  ): Promise<void> {
    const argument = interpreterScriptArgument(argv);
    if (!argument) return;
    let bytes: Buffer | undefined;
    for (const candidate of candidates) {
      bytes = await readFile(candidate).catch(() => undefined);
      if (bytes) break;
    }
    if (!bytes) return;
    const script = grant.script;
    if (!script || script.path !== argument.path) {
      throw new Error(
        `${argument.path} is a script no human has read: this grant was approved without it. ` +
          'Ask with request_grant kind=command so the card carries what the command runs.',
      );
    }
    if (createHash('sha256').update(bytes).digest('hex') !== script.sha256) {
      throw new Error(
        `${argument.path} changed after it was approved, so the approval no longer covers it. ` +
          'Ask with request_grant kind=command again so a human reads what runs now.',
      );
    }
  }
}

/**
 * Where a script argument may live, in the order `resolveAttachPath` tried at
 * request time: the checkout first, the session scratch second. Same order, so
 * the bytes re-hashed here are the bytes the card showed.
 */
function scriptCandidates(
  cwd: string,
  scratch: string | undefined,
  argv: readonly string[],
): string[] {
  const argument = interpreterScriptArgument(argv);
  if (!argument) return [];
  const paths = [resolve(cwd, argument.path), ...(scratch ? [resolve(scratch, argument.path)] : [])];
  return [...new Set(paths)];
}

/** The bwrap-wrapped argv for a Room run, or a refusal when the host cannot wrap. */
function roomSandboxCommand(
  policy: GrantWritePolicy,
  cwd: string,
  argv: readonly string[],
): { command: string; args: string[] } {
  if (!policy.bwrapPath) throw new Error(ROOM_SANDBOX_UNAVAILABLE);
  return wrapAgentCommand({
    bwrapPath: policy.bwrapPath,
    spec: {
      mode: 'readonly',
      cwd,
      // The Room keeps every writable surface its session already had: the
      // scratch and the agent-home overlay. Only the repository copy and the
      // live host become read-only.
      ...(policy.harnessStateDirs ? { harnessStateDirs: policy.harnessStateDirs } : {}),
      ...(policy.scratch ? { tmpDir: policy.scratch } : {}),
      ...(policy.maskPaths ? { maskPaths: policy.maskPaths } : {}),
    },
    command: argv[0]!,
    args: argv.slice(1),
  });
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
