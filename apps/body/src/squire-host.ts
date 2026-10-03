/**
 * Trusty Squire's host rewrite: one Chrome, one broker socket, many façades.
 *
 * Every ACP child is bwrapped with --tmpfs /tmp, so Squire's default /tmp
 * socket is a different inode inside each agent. That is the
 * eight-brokers-at-100-percent-CPU incident. The host rewrite points every
 * façade at <host home>/.trusty-squire/broker.sock, bind-mounts that directory
 * read-write, and elects the daemon from a host user unit outside that mount
 * namespace. A sandboxed façade never elects.
 */
import { spawn } from 'node:child_process';
import {
  accessSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { createConnection } from 'node:net';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSquireBrokerLink } from './squire-broker-link.js';
import { reclaimSquireBrokerSockets } from './squire-broker-squatter.js';

export const SQUIRE_BROKER_UNAVAILABLE = 'broker unavailable';
export const TRUSTY_SQUIRE_BROKER_UNIT_NAME = 'trusty-squire-broker.service';
/** Hidden CLI flag so a bundled `beeline` process can be the façade child. */
export const SQUIRE_FACADE_FLAG = '--squire-facade';
/** Hidden CLI flag so the host user unit can elect through the installed launcher. */
export const SQUIRE_BROKER_FLAG = '--squire-broker';
export const SQUIRE_MCP_PACKAGE_NAME = '@trusty-squire/mcp';
/** Bounds a crash-restart storm (RestartSec=5s) to this many attempts per window. */
export const SQUIRE_BROKER_START_LIMIT_INTERVAL_SEC = 60;
export const SQUIRE_BROKER_START_LIMIT_BURST = 6;

export type SquireHostPaths = {
  readonly dir: string;
  readonly profileDir: string;
  readonly configHome: string;
  readonly brokerSocket: string;
  /**
   * Squire's own shared MCP listener socket (`bot/broker/mcp-socket-path.js`
   * `sharedMcpSocketPath()`): `<dir>/mcp.sock` for the canonical profile dir
   * Beeline always configures. This is what `runSquireBrokerLink` connects
   * to — a different socket from `brokerSocket`, the broker's own wire
   * control protocol.
   */
  readonly mcpSocket: string;
};

/** Host paths derived from the operator home, never from a sandbox $HOME. */
export function squireHostPaths(home: string): SquireHostPaths {
  const dir = join(resolve(home), '.trusty-squire');
  return {
    dir,
    profileDir: join(dir, 'chrome-profile'),
    configHome: join(resolve(home), '.config'),
    brokerSocket: join(dir, 'broker.sock'),
    mcpSocket: join(dir, 'mcp.sock'),
  };
}

export function squireHostRewriteEnv(home: string): Record<string, string> {
  const paths = squireHostPaths(home);
  return {
    TRUSTY_SQUIRE_PROFILE_DIR: paths.profileDir,
    XDG_CONFIG_HOME: paths.configHome,
    TRUSTY_SQUIRE_BROKER_SOCKET: paths.brokerSocket,
  };
}

export function ensureSquireHostDir(home: string): SquireHostPaths {
  const paths = squireHostPaths(home);
  mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  mkdirSync(paths.profileDir, { recursive: true, mode: 0o700 });
  return paths;
}

/** Squire's managed-broker marker file (`dist/bot/broker/managed-marker.js`). */
export const SQUIRE_BROKER_UNIT_MARKER_FILE = '.trusty-squire-broker-unit.json';

/**
 * Declare the host unit as the owner of the shared Chrome profile. Squire
 * clients (1.1.24+) that find this marker beside the profile wait for its
 * socket and never spawn a broker, even inside a bwrap sandbox where the
 * `systemctl --user` probe cannot reach the bus and would otherwise fall
 * through to "spawn". `profile` is Squire's device anchor: the canonical
 * parent's dev/ino plus the profile directory's resolved name. A null
 * `accountBinding` is "unclaimed", which every client may join.
 */
export function writeSquireBrokerUnitMarker(home: string): string {
  const paths = ensureSquireHostDir(home);
  const profile = realpathSync.native(paths.profileDir);
  const parent = dirname(profile);
  const { dev, ino } = statSync(parent);
  const path = join(parent, SQUIRE_BROKER_UNIT_MARKER_FILE);
  const marker = {
    version: 1,
    socket: paths.brokerSocket,
    profile: { dev, ino, name: basename(profile) },
    accountBinding: null,
  };
  writeFileSync(path, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600 });
  return path;
}

/**
 * Bind-mount the host broker directory read-write, and only for an agent whose
 * grant actually rewrites a Squire route: the broker socket and the logged-in
 * Chrome profile live there, so an unrelated `mcp` grant must not reach them.
 */
export function squireHostBindPaths(home: string, squireRouteGranted: boolean): string[] {
  if (!squireRouteGranted) return [];
  return [ensureSquireHostDir(home).dir];
}

/**
 * Whether this process can write into the broker's own directory — the bind
 * `squireHostBindPaths` grants only to a façade whose Squire route was
 * actually rewritten. A read-only bind mount does not stop a process from
 * `connect()`ing a Unix socket underneath it (connecting is not a
 * filesystem write), so socket reachability alone cannot tell a granted
 * façade from an unrelated one — only this can. Required alongside
 * `squireBrokerSocketReady`: without it, an unrelated `mcp` grant's façade
 * would reach the real broker over its shared MCP socket just as
 * successfully as a Squire-granted one.
 */
export function squireHostDirWritable(socketPath: string): boolean {
  try {
    accessSync(dirname(socketPath), fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * A façade may spawn the relay only when the host daemon is actually
 * listening — never on a stale socket inode a crashed/restart-looping
 * broker left behind. A dead `trusty-squire-broker.service` leaves its
 * `broker.sock` file on disk (only a graceful close unlinks it), so an
 * `lstat` type check alone reports "ready" while nothing answers; this is
 * exactly what let a façade fall through to `npx @trusty-squire/mcp server`,
 * whose own on-demand-launch fallback then elected a second, agent-owned
 * broker while the host unit was mid-restart-loop. A real connect attempt is
 * the only way to tell a live listener from an orphaned file.
 */
export async function squireBrokerSocketReady(socketPath: string): Promise<boolean> {
  return await new Promise((resolveReady) => {
    const probe = createConnection(socketPath);
    probe.once('connect', () => {
      probe.destroy();
      resolveReady(true);
    });
    probe.once('error', () => {
      probe.destroy();
      resolveReady(false);
    });
  });
}

/**
 * The per-client façade entry: the compiled module beside this one, its source
 * through tsx in a source checkout, or the bundled CLI plus its hidden flag —
 * the single-file release bundle has no sibling module to spawn.
 */
export type SquireAgentScope = {
  readonly agentId: string;
  readonly roomId: string;
  readonly relay?: { readonly url: string; readonly token: string; readonly contextFile: string };
};

export function squireFacadeLaunch(home: string, scope: SquireAgentScope): {
  command: string;
  args: string[];
  env: Record<string, string>;
} {
  if (!scope.agentId || !scope.roomId) throw new Error('Squire agent and Room IDs are required');
  const env = scope.relay
    ? {
        BEELINE_SQUIRE_RELAY_URL: scope.relay.url,
        BEELINE_SQUIRE_RELAY_TOKEN: scope.relay.token,
        BEELINE_TURN_CONTEXT_FILE: scope.relay.contextFile,
      }
    : squireHostRewriteEnv(home);
  const meta = import.meta.url;
  if (meta.startsWith('beeline:')) {
    const entry = process.argv[1];
    if (!entry) throw new Error('Squire façade cannot resolve the Beeline CLI entry');
    return { command: process.execPath, args: [entry, SQUIRE_FACADE_FLAG], env };
  }
  const js = fileURLToPath(new URL('./squire-facade.js', meta));
  if (existsSync(js)) return { command: process.execPath, args: [js], env };
  const ts = fileURLToPath(new URL('./squire-facade.ts', meta));
  if (existsSync(ts)) {
    const tsx = createRequire(meta).resolve('tsx');
    return { command: process.execPath, args: ['--import', tsx, ts], env };
  }
  throw new Error('Squire façade entry not found next to the Beeline helper');
}

/**
 * A durable local copy of Squire the broker (re)starts from directly — never
 * `npx`, never the registry, on every restart. A crash-restart storm used to
 * mean hundreds of `npx …@latest broker` round trips (each one a registry
 * resolution AND a full npm package load); after this copy exists, a restart
 * costs one `existsSync`.
 */
export const SQUIRE_BROKER_INSTALL_DIRNAME = 'mcp-broker-install';

export function squireBrokerInstallDir(home: string): string {
  return join(squireHostPaths(home).dir, SQUIRE_BROKER_INSTALL_DIRNAME);
}

/** The installed package's own `bin.mcp` entry (`dist/bin.js`), resolved without touching npm. */
export function squireBrokerInstallEntry(home: string): string {
  return join(
    squireBrokerInstallDir(home),
    'node_modules',
    '@trusty-squire',
    'mcp',
    'dist',
    'bin.js',
  );
}

export type SquireInstallRunner = (
  command: string,
  args: readonly string[],
  options: { cwd: string },
) => Promise<{ code: number | null; stderr: string }>;

const defaultSquireInstallRunner: SquireInstallRunner = (command, args, options) =>
  new Promise((resolveRun) => {
    const child = spawn(command, [...args], { cwd: options.cwd, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.once('error', (error) => resolveRun({ code: 1, stderr: error.message }));
    child.once('close', (code) => resolveRun({ code, stderr }));
  });

/**
 * Pin the durable broker install, installing it only when it is missing.
 * This is the one deliberate update point: `beeline start`/pairing and the
 * managed update converge path call it before the unit (re)starts, so
 * `runSquireBroker` itself never has to reach the network. Idempotent and
 * network-free once the entry exists on disk.
 */
export async function ensureSquireBrokerInstall(
  home: string,
  options: { run?: SquireInstallRunner; spec?: string } = {},
): Promise<string> {
  const entry = squireBrokerInstallEntry(home);
  if (existsSync(entry)) return entry;
  const dir = squireBrokerInstallDir(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const run = options.run ?? defaultSquireInstallRunner;
  const spec = options.spec ?? `${SQUIRE_MCP_PACKAGE_NAME}@latest`;
  const result = await run(
    'npm',
    ['install', '--prefix', dir, spec, '--no-save', '--no-audit', '--no-fund', '--no-package-lock'],
    { cwd: dir },
  );
  if (result.code !== 0 || !existsSync(entry))
    throw new Error(
      `Trusty Squire broker install failed: ${result.stderr.trim() || `${entry} is missing`}`,
    );
  return entry;
}

/** The host elector: one user unit, no PrivateTmp, same socket every façade sees. */
export function trustySquireBrokerUnit(nodeExecPath = process.execPath): string {
  return `[Unit]
Description=Trusty Squire host broker
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=${SQUIRE_BROKER_START_LIMIT_INTERVAL_SEC}
StartLimitBurst=${SQUIRE_BROKER_START_LIMIT_BURST}

[Service]
Type=simple
WorkingDirectory=%h
Environment=PATH=${dirname(nodeExecPath)}:%h/.local/bin:/usr/local/bin:/usr/bin:/bin
Environment=TRUSTY_SQUIRE_PROFILE_DIR=%h/.trusty-squire/chrome-profile
Environment=XDG_CONFIG_HOME=%h/.config
Environment=TRUSTY_SQUIRE_BROKER_SOCKET=%h/.trusty-squire/broker.sock
ExecStartPre=/bin/mkdir -p %h/.trusty-squire
ExecStart=%h/.local/bin/beeline ${SQUIRE_BROKER_FLAG}
Restart=on-failure
RestartSec=5s
UMask=0077
NoNewPrivileges=yes

[Install]
WantedBy=default.target
`;
}

function spawnSquireBrokerProcess(entry: string, env: NodeJS.ProcessEnv): void {
  const child = spawn(process.execPath, [entry, 'broker'], { env, stdio: 'inherit' });
  child.on('exit', (code, signal) => {
    if (signal) process.exit(1);
    process.exit(code ?? 1);
  });
}

/**
 * Host elector: spawn Squire's broker even when no socket exists yet. A live
 * same-profile broker the unit did not start is stopped first; any other
 * holder of the unit's sockets fails the start with a reason naming it.
 * Never `npx`: the durable install pinned by `ensureSquireBrokerInstall` is
 * the only thing this ever launches, so a restart never resolves `@latest`
 * from the registry or reloads the whole npm package.
 */
export async function runSquireBroker(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const home = env.HOME?.trim() || homedir();
  const paths = ensureSquireHostDir(home);
  const reclaimed = await reclaimSquireBrokerSockets({
    sockets: [paths.mcpSocket, paths.brokerSocket],
    profileDir: paths.profileDir,
  });
  if (!reclaimed.ok) {
    process.stderr.write(`[beeline] Trusty Squire broker not started: ${reclaimed.reason}\n`);
    process.exit(1);
    return;
  }
  let entry: string;
  try {
    entry = await ensureSquireBrokerInstall(home);
  } catch (error) {
    process.stderr.write(
      `[beeline] Trusty Squire broker not started: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    process.exit(1);
    return;
  }
  spawnSquireBrokerProcess(entry, {
    ...env,
    ...squireHostRewriteEnv(home),
    TRUSTY_SQUIRE_BROKER_SOCKET: paths.brokerSocket,
    // Squire's daemon refuses to start under the managed marker unless the
    // unit started it; launchd sets no INVOCATION_ID, so say so explicitly.
    TRUSTY_SQUIRE_BROKER_UNIT: '1',
  });
}

/**
 * The façade's whole session, connect-only. `squireHostDirWritable` +
 * `squireBrokerSocketReady` are the fast pre-check (near-instant refusal
 * when this façade has no Squire grant, or the broker is plainly absent);
 * `runSquireBrokerLink` (`squire-broker-link.ts`) is the actual MCP
 * transport for the rest of the process's life, including every later
 * reconnect — it never delegates to Squire's own `server` subcommand, so
 * there is nothing left that can fall through to an on-demand broker launch.
 */
export async function runSquireFacade(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const socket =
    env.TRUSTY_SQUIRE_BROKER_SOCKET ?? squireHostPaths(env.HOME?.trim() || homedir()).brokerSocket;
  if (!squireHostDirWritable(socket) || !(await squireBrokerSocketReady(socket))) {
    process.stderr.write(
      `${SQUIRE_BROKER_UNAVAILABLE}: ${TRUSTY_SQUIRE_BROKER_UNIT_NAME} is not reachable at ${socket}\n`,
    );
    process.exitCode = 1;
    return;
  }
  // Squire's own `sharedMcpSocketPath()` is `<privateDir>/mcp.sock`
  // alongside `<privateDir>/broker.sock` (bot/broker/mcp-socket-path.js,
  // for the canonical profile dir Beeline always configures); deriving it
  // from the broker socket that was actually resolved above — rather than
  // re-deriving `home` from `env.HOME` — stays correct even when this
  // process's own $HOME has been rewritten for sandboxing, since
  // TRUSTY_SQUIRE_BROKER_SOCKET is always set to the real host path.
  const mcpSocket = join(dirname(socket), 'mcp.sock');
  // The broker's wire protocol requires an identity line (`listenSharedMcp`),
  // but #1790's per-agent value never affected a session (browser sessions
  // are owned by the MCP connection, not this string) and its generator is
  // already gone (#1797) — every façade is this one helper process.
  const { ok } = await runSquireBrokerLink({
    agentId: 'beeline-helper',
    socketPath: mcpSocket,
  });
  // Squire's own `bin.js` force-exits after its relay resolves for the same
  // reason: once stdin has been read in flowing mode there is no natural
  // "idle" for Node to exit on, so a process relying on that alone would
  // hang forever after a clean stop/give-up instead of returning control to
  // whatever spawned it.
  process.exit(ok ? 0 : 1);
}
