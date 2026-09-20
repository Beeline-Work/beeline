/**
 * Trusty Squire's host rewrite: one Chrome, one broker socket, many façades.
 *
 * Agent units run PrivateTmp=yes and every ACP child is bwrapped with
 * --tmpfs /tmp, so Squire's default /tmp socket is a different inode inside
 * each agent. That is the eight-brokers-at-100-percent-CPU incident. The
 * host rewrite points every façade at <host home>/.trusty-squire/broker.sock,
 * bind-mounts that directory read-write, and elects the daemon from a host
 * user unit with no PrivateTmp. A sandboxed façade never elects.
 */
import { spawn } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SQUIRE_BROKER_UNAVAILABLE = 'broker unavailable';
export const SQUIRE_PROFILE_BUSY = 'profile_busy';
export const TRUSTY_SQUIRE_BROKER_UNIT_NAME = 'trusty-squire-broker.service';

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

export function squireSessionFile(configHome: string): string {
  return join(resolve(configHome), 'trusty-squire', 'session.json');
}

/** The façade pairs when it can read a non-empty host session.json. */
export function squireFacadeIsPaired(env: NodeJS.ProcessEnv = process.env): boolean {
  const configHome =
    env.XDG_CONFIG_HOME?.trim() || join(env.HOME?.trim() || homedir(), '.config');
  try {
    return readFileSync(squireSessionFile(configHome), 'utf8').trim().length > 0;
  } catch {
    return false;
  }
}

export function squireFacadeProbe(env: NodeJS.ProcessEnv = process.env): {
  paired: boolean;
  socketReady: boolean;
} {
  const paths = squireHostPaths(env.HOME?.trim() || homedir());
  const socket = env.TRUSTY_SQUIRE_BROKER_SOCKET ?? paths.brokerSocket;
  return {
    paired: squireFacadeIsPaired(env),
    socketReady: squireFacadeMaySpawn(socket),
  };
}

/**
 * Unfixed PrivateTmp layout: each agent elects its own broker socket and
 * Chrome profile. Two agents → two inodes and two Chromes.
 */
export function squirePrivateTmpTopology(agentHomes: readonly string[]): {
  sockets: string[];
  chromeProfiles: string[];
} {
  return {
    sockets: agentHomes.map((home) => join(home, 'tmp', 'trusty-squire.sock')),
    chromeProfiles: agentHomes.map((home) => join(home, '.trusty-squire', 'chrome-profile')),
  };
}

export function squireUnfixedProcessPlan(agentCount: number): {
  daemons: number;
  chromes: number;
  facades: number;
  refusals: number;
} {
  return { daemons: agentCount, chromes: agentCount, facades: 0, refusals: 0 };
}

export function ensureSquireHostDir(home: string): SquireHostPaths {
  const paths = squireHostPaths(home);
  mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  mkdirSync(paths.profileDir, { recursive: true, mode: 0o700 });
  return paths;
}

/** Bind-mount the host broker directory read-write when a host route is granted. */
export function squireHostBindPaths(home: string, granted: readonly string[]): string[] {
  if (granted.length === 0) return [];
  return [ensureSquireHostDir(home).dir];
}

export function squireBrokerSocketReady(socketPath: string): boolean {
  try {
    return lstatSync(socketPath).isSocket();
  } catch {
    return false;
  }
}

/** A façade may spawn only when the host daemon already holds the socket. */
export function squireFacadeMaySpawn(socketPath: string): boolean {
  return squireBrokerSocketReady(socketPath);
}

export function squireTurnFailure(text: string | undefined | null): typeof SQUIRE_PROFILE_BUSY | typeof SQUIRE_BROKER_UNAVAILABLE | undefined {
  if (typeof text !== 'string' || text.length === 0) return undefined;
  if (new RegExp(SQUIRE_BROKER_UNAVAILABLE, 'i').test(text)) return SQUIRE_BROKER_UNAVAILABLE;
  if (
    /profile_busy/i.test(text) ||
    /Trusty Squire[\s\S]{0,80}browser/i.test(text) ||
    /browser[\s\S]{0,80}Trusty Squire/i.test(text)
  ) {
    return SQUIRE_PROFILE_BUSY;
  }
  return undefined;
}

export function squireFacadeScriptPath(): string {
  return fileURLToPath(new URL('./squire-facade.js', import.meta.url));
}

/**
 * The per-client façade launch written into an isolated harness home. The
 * wrapper refuses to start when the host socket is missing, so a sandbox
 * never elects.
 */
export function squireFacadeLaunch(home: string): {
  command: string;
  args: string[];
  env: Record<string, string>;
} {
  const compiled = squireFacadeScriptPath();
  const script = existsSync(compiled) ? compiled : compiled.replace(/\.js$/, '.ts');
  return {
    command: process.execPath,
    args: [script],
    env: squireHostRewriteEnv(home),
  };
}

/**
 * Observable topology for the RED/GREEN broker-count proof: two agents on
 * one host share one daemon socket and one Chrome profile.
 */
export function squireHostTopology(
  home: string,
  agentIds: readonly string[],
): {
  daemonSocket: string;
  chromeProfile: string;
  facades: Array<{ agentId: string; brokerSocket: string; profileDir: string }>;
} {
  const paths = squireHostPaths(home);
  return {
    daemonSocket: paths.brokerSocket,
    chromeProfile: paths.profileDir,
    facades: agentIds.map((agentId) => ({
      agentId,
      brokerSocket: paths.brokerSocket,
      profileDir: paths.profileDir,
    })),
  };
}

export function squireProcessPlan(input: {
  hostHome: string;
  agentCount: number;
  brokerReady: boolean;
}): { daemons: number; chromes: number; facades: number; refusals: number } {
  if (!input.brokerReady) {
    return { daemons: 0, chromes: 0, facades: 0, refusals: input.agentCount };
  }
  return { daemons: 1, chromes: 1, facades: input.agentCount, refusals: 0 };
}

/** The host elector: one user unit, no PrivateTmp, same socket every façade sees. */
export function trustySquireBrokerUnit(): string {
  return `[Unit]
Description=Trusty Squire host broker
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=%h
Environment=TRUSTY_SQUIRE_PROFILE_DIR=%h/.trusty-squire/chrome-profile
Environment=XDG_CONFIG_HOME=%h/.config
Environment=TRUSTY_SQUIRE_BROKER_SOCKET=%h/.trusty-squire/broker.sock
ExecStartPre=/bin/mkdir -p %h/.trusty-squire
ExecStart=/usr/bin/env npx -y @trusty-squire/mcp@latest server
Restart=on-failure
RestartSec=5s
UMask=0077
NoNewPrivileges=yes

[Install]
WantedBy=default.target
`;
}

export function runSquireFacade(
  env: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = process.argv,
): void {
  if (argv.includes('--probe')) {
    const probe = squireFacadeProbe(env);
    const ok = probe.paired && probe.socketReady;
    process.stdout.write(ok ? 'paired\n' : 'unpaired\n');
    process.exitCode = ok ? 0 : 1;
    return;
  }
  const socket = env.TRUSTY_SQUIRE_BROKER_SOCKET ?? squireHostPaths(env.HOME?.trim() || homedir()).brokerSocket;
  if (!squireFacadeMaySpawn(socket)) {
    process.stderr.write(`${SQUIRE_BROKER_UNAVAILABLE}\n`);
    process.exitCode = 1;
    return;
  }
  const child = spawn('npx', ['-y', '@trusty-squire/mcp@latest', 'server'], {
    env: { ...env, TRUSTY_SQUIRE_BROKER_SOCKET: socket },
    stdio: 'inherit',
  });
  child.on('exit', (code, signal) => {
    if (signal) process.exit(1);
    process.exit(code ?? 1);
  });
}
