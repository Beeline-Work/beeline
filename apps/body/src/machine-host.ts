import { execFile } from 'node:child_process';
import { hostname } from 'node:os';

export interface MachineHost {
  readonly hostname: string;
  readonly tailscaleName?: string;
}

/** Read only the local daemon's DNS name; a missing or offline Tailscale is ordinary. */
export async function machineHost(): Promise<MachineHost> {
  const local = hostname();
  const tailscaleName = await new Promise<string | undefined>((resolve) => {
    execFile('tailscale', ['status', '--json'], { timeout: 1_500, maxBuffer: 64 * 1024 },
      (error, stdout) => {
        if (error) return resolve(undefined);
        try {
          const status = JSON.parse(stdout) as { BackendState?: string; Self?: { DNSName?: string } };
          const name = status.BackendState === 'Running' ? status.Self?.DNSName?.replace(/\.$/, '') : undefined;
          resolve(name || undefined);
        } catch {
          resolve(undefined);
        }
      });
  });
  return { hostname: local, ...(tailscaleName ? { tailscaleName } : {}) };
}
