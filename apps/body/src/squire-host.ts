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
import { existsSync, lstatSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SQUIRE_BROKER_UNAVAILABLE = 'broker unavailable';
export const TRUSTY_SQUIRE_BROKER_UNIT_NAME = 'trusty-squire-broker.service';
/** Hidden CLI flag so a bundled `beeline` process can be the façade child. */
export const SQUIRE_FACADE_FLAG = '--squire-facade';
/** Hidden CLI flag so the host user unit can elect through the installed launcher. */
export const SQUIRE_BROKER_FLAG = '--squire-broker';
export const SQUIRE_SERVER_ARGS = ['-y', '@trusty-squire/mcp@latest', 'server'] as const;
export const SQUIRE_BROKER_ARGS = ['-y', '@trusty-squire/mcp@latest', 'broker'] as const;

export type SquireHostPaths = {
  readonly dir: string;
  readonly profileDir: string;
  readonly configHome: string;
  readonly brokerSocket: string;
};

/** Host paths derived from the operator home, never from a sandbox $HOME. */
export function squireHostPaths(home: string): SquireHostPaths {
  const dir = join(resolve(home), '.trusty-squire');
  return {
    dir,
    profileDir: join(dir, 'chrome-profile'),
    configHome: join(resolve(home), '.config'),
    brokerSocket: join(dir, 'broker.sock'),
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

/**
 * Bind-mount the host broker directory read-write, and only for an agent whose
 * grant actually rewrites a Squire route: the broker socket and the logged-in
 * Chrome profile live there, so an unrelated `mcp` grant must not reach them.
 */
export function squireHostBindPaths(home: string, squireRouteGranted: boolean): string[] {
  if (!squireRouteGranted) return [];
  return [ensureSquireHostDir(home).dir];
}

/** A façade may spawn only when the host daemon already holds the socket. */
export function squireBrokerSocketReady(socketPath: string): boolean {
  try {
    return lstatSync(socketPath).isSocket();
  } catch {
    return false;
  }
}

/**
 * The per-client façade entry: the compiled module beside this one, its source
 * through tsx in a source checkout, or the bundled CLI plus its hidden flag —
 * the single-file release bundle has no sibling module to spawn.
 */
export function squireFacadeLaunch(home: string): {
  command: string;
  args: string[];
  env: Record<string, string>;
} {
  const env = squireHostRewriteEnv(home);
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
 * Locate npx next to the running node so a systemd user unit does not depend
 * on a shell PATH. fnm/nvm/volta put `npx` beside `process.execPath`.
 */
export function squireServerCommand(nodeExecPath = process.execPath): {
  command: string;
  args: string[];
  pathPrefix: string;
} {
  const binDir = dirname(nodeExecPath);
  const sibling = join(binDir, 'npx');
  const args = [...SQUIRE_SERVER_ARGS];
  if (existsSync(sibling)) return { command: sibling, args, pathPrefix: binDir };
  return { command: 'npx', args, pathPrefix: binDir };
}

/** The host elector: one user unit, no PrivateTmp, same socket every façade sees. */
export function trustySquireBrokerUnit(nodeExecPath = process.execPath): string {
  return `[Unit]
Description=Trusty Squire host broker
After=network-online.target
Wants=network-online.target

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

function spawnSquireServer(env: NodeJS.ProcessEnv, locateNpx: boolean, args: readonly string[]): void {
  const launch = locateNpx
    ? { ...squireServerCommand(), args: [...args] }
    : { command: 'npx', args: [...args], pathPrefix: '' };
  const path = [launch.pathPrefix, env.PATH || '/usr/bin:/bin'].filter(Boolean).join(':');
  const child = spawn(launch.command, launch.args, {
    env: { ...env, PATH: path },
    stdio: 'inherit',
  });
  child.on('exit', (code, signal) => {
    if (signal) process.exit(1);
    process.exit(code ?? 1);
  });
}

/** Host elector: spawn Squire's server even when no socket exists yet. */
export function runSquireBroker(env: NodeJS.ProcessEnv = process.env): void {
  const home = env.HOME?.trim() || homedir();
  const paths = ensureSquireHostDir(home);
  spawnSquireServer(
    { ...env, ...squireHostRewriteEnv(home), TRUSTY_SQUIRE_BROKER_SOCKET: paths.brokerSocket },
    true,
    SQUIRE_BROKER_ARGS,
  );
}

export function runSquireFacade(env: NodeJS.ProcessEnv = process.env): void {
  const socket =
    env.TRUSTY_SQUIRE_BROKER_SOCKET ?? squireHostPaths(env.HOME?.trim() || homedir()).brokerSocket;
  if (!squireBrokerSocketReady(socket)) {
    process.stderr.write(`${SQUIRE_BROKER_UNAVAILABLE}\n`);
    process.exitCode = 1;
    return;
  }
  spawnSquireServer({ ...env, TRUSTY_SQUIRE_BROKER_SOCKET: socket }, false, SQUIRE_SERVER_ARGS);
}
