import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';

export const TRUSTY_SQUIRE_RUNTIME_CONFIG_DIR = 'squire-host-config';

export function trustySquireConfigRoot(runtimeDir: string): string {
  return resolve(runtimeDir, TRUSTY_SQUIRE_RUNTIME_CONFIG_DIR);
}

export function trustySquireStorePath(configRoot: string): string {
  return resolve(configRoot, 'trusty-squire');
}

export function trustySquireLegacyStorePaths(
  operatorHome = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const roots = new Set([resolve(operatorHome, '.config')]);
  const xdgConfig = env.XDG_CONFIG_HOME?.trim();
  if (xdgConfig && isAbsolute(xdgConfig)) roots.add(resolve(xdgConfig));
  return [...roots].map((root) => resolve(root, 'trusty-squire'));
}

export function trustySquireIpcPaths(env: NodeJS.ProcessEnv = process.env): string[] {
  const paths = new Set<string>();
  for (const address of [env.DBUS_SESSION_BUS_ADDRESS, env.DBUS_STARTER_ADDRESS]) {
    if (!address?.trim()) continue;
    for (const endpoint of address.split(';')) {
      const match = /(?:^unix:|,)path=([^,]+)/.exec(endpoint);
      if (match?.[1] && isAbsolute(match[1])) paths.add(resolve(match[1]));
    }
  }
  const runtimeRoot = env.XDG_RUNTIME_DIR?.trim();
  if (runtimeRoot && isAbsolute(runtimeRoot)) paths.add(resolve(runtimeRoot, 'bus'));
  if (process.platform === 'linux' && process.getuid) {
    paths.add(resolve('/run/user', String(process.getuid()), 'bus'));
  }
  return [...paths];
}

export function hasUnmaskableTrustySquireIpc(env: NodeJS.ProcessEnv = process.env): boolean {
  return [env.DBUS_SESSION_BUS_ADDRESS, env.DBUS_STARTER_ADDRESS].some((address) =>
    address
      ?.split(';')
      .filter(Boolean)
      .some((endpoint) => {
        const match = /(?:^unix:|,)path=([^,]+)/.exec(endpoint);
        return !match?.[1] || !isAbsolute(match[1]);
      }),
  );
}

export function trustySquireIsolationPaths(input: {
  configRoot: string;
  operatorHome?: string;
  env?: NodeJS.ProcessEnv;
}): string[] {
  return [
    trustySquireStorePath(input.configRoot),
    ...trustySquireLegacyStorePaths(input.operatorHome, input.env),
    ...trustySquireIpcPaths(input.env),
  ].filter((path, index, all) => all.indexOf(path) === index);
}

export function existingTrustySquireIsolationPaths(input: {
  configRoot: string;
  operatorHome?: string;
  env?: NodeJS.ProcessEnv;
}): string[] {
  return trustySquireIsolationPaths(input).filter(existsSync);
}

export function trustySquireHostEnv(
  env: NodeJS.ProcessEnv,
  configRoot: string,
): NodeJS.ProcessEnv {
  const allowed = new Set([
    'HOME',
    'PATH',
    'TMPDIR',
    'LANG',
    'LC_ALL',
    'XDG_CACHE_HOME',
    'XDG_STATE_HOME',
    'NODE_EXTRA_CA_CERTS',
  ]);
  return {
    ...Object.fromEntries(
      Object.entries(env).filter(
        ([name, value]) => value !== undefined && allowed.has(name),
      ),
    ),
    XDG_CONFIG_HOME: resolve(configRoot),
    TRUSTY_SQUIRE_SESSION_FILE: '1',
  };
}
