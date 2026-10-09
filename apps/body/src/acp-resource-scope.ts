import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { totalmem } from 'node:os';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
// Leave at least 8 GiB for emulator and Metro while scaling with host RAM.
export function acpSessionMemoryMaxBytes(hostMemoryBytes = totalmem()): number {
  return Math.max(8 * 1024 ** 3, Math.floor(hostMemoryBytes / 4));
}

export const ACP_SESSION_MEMORY_MAX_BYTES = acpSessionMemoryMaxBytes();

/** A scope is a cgroup subtree, so tools that call setsid still belong to it. */
export class AcpResourceScope {
  readonly unit = `beeline-acp-${randomUUID()}.scope`;
  #stop?: Promise<void>;

  constructor(readonly memoryMaxBytes = ACP_SESSION_MEMORY_MAX_BYTES) {}

  launch(command: string, args: readonly string[], agentEnv: NodeJS.ProcessEnv): {
    command: string;
    args: string[];
    env: NodeJS.ProcessEnv;
  } {
    const env = { ...agentEnv };
    // systemd-run needs the caller's user bus. Keep that extra authority out of
    // the harness unless its ordinary allowlist already supplied it.
    const stripBus = !Object.hasOwn(agentEnv, 'DBUS_SESSION_BUS_ADDRESS');
    if (stripBus && process.env.DBUS_SESSION_BUS_ADDRESS)
      env.DBUS_SESSION_BUS_ADDRESS = process.env.DBUS_SESSION_BUS_ADDRESS;
    if (!env.XDG_RUNTIME_DIR && process.env.XDG_RUNTIME_DIR)
      env.XDG_RUNTIME_DIR = process.env.XDG_RUNTIME_DIR;
    const stripRuntime = !Object.hasOwn(agentEnv, 'XDG_RUNTIME_DIR');
    const owner = managedServiceUnit();
    return {
      command: 'systemd-run',
      args: [
        '--user', '--scope', '--quiet', '--same-dir', `--unit=${this.unit}`,
        `--property=MemoryMax=${this.memoryMaxBytes}`,
        '--property=MemorySwapMax=0',
        '--property=OOMPolicy=kill',
        '--property=KillMode=control-group',
        '--property=TimeoutStopSec=1s',
        ...(owner ? [`--property=BindsTo=${owner}`, `--property=After=${owner}`] : []),
        '/usr/bin/env',
        ...(stripBus ? ['-u', 'DBUS_SESSION_BUS_ADDRESS'] : []),
        ...(stripRuntime ? ['-u', 'XDG_RUNTIME_DIR'] : []),
        command,
        ...args,
      ],
      env,
    };
  }

  /** An OOM result survives process exit until reset-failed unloads the unit. */
  async exceededMemoryLimit(): Promise<boolean> {
    try {
      const { stdout } = await execFileAsync('systemctl',
        ['--user', 'show', this.unit, '--property=Result', '--value'], { timeout: 5_000 });
      return stdout.trim() === 'oom-kill';
    } catch {
      return false;
    }
  }

  async stop(): Promise<void> {
    return (this.#stop ??= (async () => {
      try {
        await execFileAsync('systemctl', ['--user', 'stop', this.unit], { timeout: 5_000 });
      } catch (error) {
        const { stdout } = await execFileAsync('systemctl',
          ['--user', 'show', this.unit, '--property=LoadState', '--value'], { timeout: 5_000 });
        if (stdout.trim() !== 'not-found') throw error;
      } finally {
        // A failed scope otherwise remains listed by the user manager forever.
        await execFileAsync('systemctl', ['--user', 'reset-failed', this.unit], { timeout: 5_000 })
          .catch(() => undefined);
      }
    })().catch((error) => {
      this.#stop = undefined;
      throw error;
    }));
  }
}

/** Bind the scope to the managed helper/per-agent unit that owns the session. */
function managedServiceUnit(): string | undefined {
  if (process.env.BEELINE_MANAGED_BY_SYSTEMD !== '1') return undefined;
  try {
    const cgroup = readFileSync('/proc/self/cgroup', 'utf8');
    const path = cgroup.split('\n').find((line) => line.startsWith('0::'))?.slice(3);
    return path?.split('/').find((part) => /^beeline-(?:helper|agent@.+)\.service$/.test(part));
  } catch {
    return undefined;
  }
}
