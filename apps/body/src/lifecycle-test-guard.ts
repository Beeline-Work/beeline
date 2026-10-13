import { existsSync, realpathSync, readFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { dirname, resolve } from 'node:path';

function physicalPath(path: string): string {
  const absolute = resolve(path);
  if (existsSync(absolute)) return realpathSync(absolute);
  const parent = dirname(absolute);
  return parent === absolute
    ? absolute
    : resolve(physicalPath(parent), absolute.slice(parent.length + 1));
}

/** The native proof runs in a disposable container with its own PID 1 and user bus. */
export function isolatedNativeProof(env: NodeJS.ProcessEnv): boolean {
  return (
    env.BEELINE_NATIVE_PROOF === '1' &&
    existsSync('/.dockerenv') &&
    userInfo().username === 'proof' &&
    userInfo().homedir === '/home/proof' &&
    readFileSync('/proc/1/comm', 'utf8').trim() === 'systemd' &&
    physicalPath(env.HOME || '/') === '/home/proof' &&
    physicalPath(env.XDG_CONFIG_HOME || '/') === '/home/proof/.config' &&
    physicalPath(env.XDG_STATE_HOME || '/') === '/home/proof/.local/state' &&
    env.DBUS_SESSION_BUS_ADDRESS === `unix:path=/run/user/${process.getuid?.()}/bus`
  );
}

/** Call before even an install-directory write: mocks can stop matching after a refactor. */
export function assertLifecycleTestIsolation(env: NodeJS.ProcessEnv, mockedManager = false): void {
  if (!process.env.VITEST && process.env.NODE_ENV !== 'test' && !env.BEELINE_NATIVE_PROOF) return;
  if (isolatedNativeProof(env)) return;
  const liveHome = physicalPath(userInfo().homedir);
  for (const name of ['HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME'] as const) {
    if (!env[name]) throw new Error(`lifecycle test requires an isolated ${name}`);
    const target = physicalPath(env[name]!);
    if (
      target === liveHome ||
      target.startsWith(`${liveHome}/.config`) ||
      target.startsWith(`${liveHome}/.local`)
    ) {
      throw new Error(`lifecycle test refused the real user's live install: ${name}=${target}`);
    }
  }
  for (const name of [
    'BEELINE_LIB_DIR',
    'BEELINE_INSTALL_LIB_DIR',
    'BEELINE_INSTALL_DIR',
  ] as const) {
    if (env[name] && physicalPath(env[name]!).startsWith(`${liveHome}/.local/`)) {
      throw new Error(`lifecycle test refused the real user's live install: ${name}`);
    }
  }
  if (!mockedManager)
    throw new Error(
      'lifecycle test requires a mocked service manager or the disposable native-proof container',
    );
}

/** Pure artifact tests also must not write through a live install anchor. */
export function assertInstallTestIsolation(layout: {
  binDir: string;
  libDir: string;
  releasesRoot: string;
}): void {
  if (!process.env.VITEST && process.env.NODE_ENV !== 'test') return;
  if (isolatedNativeProof(process.env)) return;
  const home = physicalPath(userInfo().homedir);
  for (const path of Object.values(layout)) {
    const target = physicalPath(path);
    if (
      target === home ||
      target.startsWith(`${home}/.local/`) ||
      target.startsWith(`${home}/.config/`)
    )
      throw new Error('artifact test refused the real user install');
  }
}
