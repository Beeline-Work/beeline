import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { withKernelLock } from './kernel-lock.js';
import { assertLifecycleTestIsolation } from './lifecycle-test-guard.js';

const exec = promisify(execFile);
export const SYSTEMD_HELPER_UNIT_NAME = 'beeline-helper.service';
export const LAUNCHD_HELPER_LABEL = 'app.usebeeline.helper';
export type NativeRunner = (
  args: string[],
  options?: { timeoutMs?: number },
) => Promise<{ stdout: string }>;

export function helperServiceUnit(): string {
  return `[Unit]
Description=Beeline helper (every agent on this machine)
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=0

[Service]
Type=notify
NotifyAccess=all
Environment=BEELINE_MANAGED_BY_SYSTEMD=1
Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=%h/.local/bin/beeline helper-bootstrap
ExecReload=/bin/kill -HUP $MAINPID
Restart=always
RestartSec=5s
RestartSteps=5
RestartMaxDelaySec=60s
WatchdogSec=180s
CPUWeight=1000
IOWeight=1000
Nice=-5
OOMScoreAdjust=-1000
OOMPolicy=continue
TimeoutStartSec=240s
TimeoutStopSec=90s
KillMode=control-group
UMask=0077
# A desktop-launched user manager may inherit Ubuntu's unprivileged_userns
# AppArmor profile. Without an explicit transition every agent inherits it too,
# so /usr/bin/bwrap cannot enter its package-provided bwrap profile.
# Do not set NoNewPrivileges or PrivateTmp on this outer service: systemd applies
# either before AppArmorProfile, which blocks this transition. Bubblewrap sets
# no-new-privs and a private /tmp inside each agent sandbox it creates.
AppArmorProfile=-unconfined

[Install]
WantedBy=default.target
`;
}

function homeFor(env: NodeJS.ProcessEnv): string {
  return env.HOME?.trim() || homedir();
}
export function nativeSupervisor(env: NodeJS.ProcessEnv = process.env): 'systemd' | 'launchd' {
  if (process.platform === 'linux' && env.BEELINE_SYSTEMD_USER !== '0') return 'systemd';
  if (process.platform === 'darwin' && env.BEELINE_LAUNCHD_USER !== '0') return 'launchd';
  throw new Error(
    'Beeline requires the native user service manager; use daemon --config only in an isolated lab',
  );
}
function xml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
export function nativeHelperPlist(env: NodeJS.ProcessEnv = process.env): string {
  const home = homeFor(env);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${LAUNCHD_HELPER_LABEL}</string>
<key>ProgramArguments</key><array><string>${xml(resolve(home, '.local/bin/beeline'))}</string><string>helper-bootstrap</string></array>
<key>EnvironmentVariables</key><dict><key>BEELINE_MANAGED_BY_LAUNCHD</key><string>1</string><key>HOME</key><string>${xml(home)}</string><key>PATH</key><string>${xml(resolve(home, '.local/bin'))}:/usr/local/bin:/usr/bin:/bin</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>5</integer><key>ExitTimeOut</key><integer>90</integer><key>Umask</key><integer>63</integer>
<key>StandardOutPath</key><string>${xml(resolve(home, 'Library/Logs/Beeline/helper.log'))}</string>
<key>StandardErrorPath</key><string>${xml(resolve(home, 'Library/Logs/Beeline/helper.log'))}</string>
</dict></plist>
`;
}

/** Forward topology migration belongs here once, before the sole helper starts. */
export async function convergeNativeHelper(
  options: {
    env?: NodeJS.ProcessEnv;
    run?: NativeRunner;
    platform?: 'systemd' | 'launchd';
    restart?: boolean;
    deadlineAt?: number;
    legacyCaller?: string;
  } = {},
): Promise<number> {
  const env = options.env ?? process.env;
  assertLifecycleTestIsolation(env, Boolean(options.run));
  const kind = options.platform ?? nativeSupervisor(env);
  const home = homeFor(env);
  if (
    env.BEELINE_LIB_DIR &&
    resolve(env.BEELINE_LIB_DIR) !== resolve(home, '.local/lib/beeline') &&
    env.BEELINE_LAB !== '1'
  )
    throw new Error(
      'native service convergence requires the canonical ~/.local install; a custom prefix is an explicit lab only',
    );
  if (!options.run)
    await readFile(resolve(home, '.local/lib/beeline-bootstrap.mjs')).catch(() => {
      throw new Error(
        'independent recovery launcher is missing; retry npx usebeeline@latest update when the published release is reachable',
      );
    });
  return withKernelLock(
    `native-helper:${home}`,
    async () => {
      const run: NativeRunner =
        options.run ??
        (async (args, opts) => {
          const remaining = (options.deadlineAt ?? Date.now() + 120_000) - Date.now();
          if (remaining <= 0) throw new Error('native service convergence deadline exceeded');
          const result = await exec(
            kind === 'systemd' ? 'systemctl' : 'launchctl',
            kind === 'systemd' ? ['--user', ...args] : args,
            {
              env,
              encoding: 'utf8',
              timeout: Math.min(opts?.timeoutMs ?? 120_000, remaining),
            },
          );
          return { stdout: result.stdout };
        });
      if (kind === 'systemd') {
        const directory = resolve(env.XDG_CONFIG_HOME || resolve(home, '.config'), 'systemd/user');
        const path = resolve(directory, SYSTEMD_HELPER_UNIT_NAME);
        await mkdir(directory, { recursive: true, mode: 0o700 });
        if ((await readFile(path, 'utf8').catch(() => '')) !== helperServiceUnit())
          await writeFile(path, helperServiceUnit(), { mode: 0o600 });
        await run(['daemon-reload']);
        const units = new Set<string>();
        for (const args of [
          ['list-unit-files', 'beeline-agent@*.service', '--no-legend', '--no-pager'],
          [
            'list-units',
            '--all',
            'beeline-agent@*.service',
            '--no-legend',
            '--no-pager',
            '--plain',
          ],
        ]) {
          const result = await run(args).catch(
            (error: { code?: unknown; stdout?: string; stderr?: string }) => {
              if (error.code === 1 && !error.stdout && !error.stderr) return { stdout: '' }; // No matching legacy units is a valid old topology.
              throw error;
            },
          );
          for (const line of result.stdout.split('\n')) {
            const columns = line.trim().split(/\s+/);
            const name = columns[0]!;
            if (args[0] === 'list-units' && columns[1] === 'not-found' && columns[2] === 'inactive')
              continue;
            if (/^beeline-agent@[0-9a-f]{64}\.service$/i.test(name)) units.add(name);
          }
        }
        const disableLegacy = async (unit: string) =>
          run(['disable', unit]).catch((error) => {
            if (!/Unit(?: file)? .*does not exist/i.test(String(error))) throw error;
          });
        if (units.size) {
          const legacyStop = resolve(directory, 'beeline-agent@.service.d');
          await mkdir(legacyStop, { recursive: true, mode: 0o700 });
          await writeFile(
            resolve(legacyStop, 'beeline-forward-migration.conf'),
            '[Service]\nTimeoutStopSec=90s\nKillMode=control-group\n',
            { mode: 0o600 },
          );
          await run(['daemon-reload']);
        }
        // A legacy unit cannot synchronously stop its own caller before it
        // gives the native manager the successor job. The new helper retries
        // old PID holders until these jobs release their agents.
        if (options.legacyCaller && units.has(options.legacyCaller)) {
          const ordering = resolve(directory, `${SYSTEMD_HELPER_UNIT_NAME}.d`);
          await mkdir(ordering, { recursive: true, mode: 0o700 });
          await writeFile(
            resolve(ordering, 'legacy-forward-migration.conf'),
            `[Unit]\nConflicts=${[...units].join(' ')}\nAfter=${[...units].join(' ')}\n`,
            { mode: 0o600 },
          );
          await run(['daemon-reload']);
          for (const unit of units) await disableLegacy(unit);
          await run(['enable', SYSTEMD_HELPER_UNIT_NAME]);
          await run(['reset-failed', SYSTEMD_HELPER_UNIT_NAME]).catch(() => undefined);
          await run(['start', '--no-block', SYSTEMD_HELPER_UNIT_NAME]);
          return 0; // Compatibility entry exits; the native owner completes convergence.
        }
        for (const unit of units) await disableLegacy(unit);
        if (units.size) await run(['stop', ...units]); // One native job batch; completion proves every old process group stopped.
        await rm(
          resolve(directory, `${SYSTEMD_HELPER_UNIT_NAME}.d/legacy-forward-migration.conf`),
          { force: true },
        );
        await rm(resolve(directory, 'beeline-agent@.service'), { force: true });
        await run(['daemon-reload']);
        await run(['enable', SYSTEMD_HELPER_UNIT_NAME]);
        await run(['reset-failed', SYSTEMD_HELPER_UNIT_NAME]).catch(() => undefined);
        // start waits for the native notify job. A timeout never disables its only restart owner.
        await run([options.restart ? 'restart' : 'start', SYSTEMD_HELPER_UNIT_NAME]);
        const state = await run(['show', '--property=MainPID', SYSTEMD_HELPER_UNIT_NAME]);
        const pid = Number(state.stdout.match(/^MainPID=(\d+)$/m)?.[1]);
        if (!Number.isSafeInteger(pid) || pid <= 0)
          throw new Error('native helper start completed without a process');
        await run(['reload', SYSTEMD_HELPER_UNIT_NAME]);
        return pid;
      }
      const domain = `gui/${process.getuid!()}`;
      const target = `${domain}/${LAUNCHD_HELPER_LABEL}`;
      const directory = resolve(home, 'Library/LaunchAgents');
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await mkdir(resolve(home, 'Library/Logs/Beeline'), { recursive: true, mode: 0o700 });
      const legacy = (await readdir(directory)).filter((entry) =>
        /^app\.usebeeline\.agent\.[0-9a-f]{64}\.plist$/i.test(entry),
      );
      const retire = async () => {
        for (const entry of legacy.sort(
          (a, b) =>
            Number(a === `${options.legacyCaller}.plist`) -
            Number(b === `${options.legacyCaller}.plist`),
        )) {
          if (!/^app\.usebeeline\.agent\.[0-9a-f]{64}\.plist$/i.test(entry)) continue;
          const label = entry.slice(0, -6);
          await run(['disable', `${domain}/${label}`]);
          await run(['bootout', `${domain}/${label}`]).catch((error) => {
            if (!/No such process|Could not find service|failed: 3\b/.test(String(error)))
              throw error;
          });
          await rm(resolve(directory, entry));
        }
      };
      if (!options.legacyCaller) await retire();
      const path = resolve(directory, `${LAUNCHD_HELPER_LABEL}.plist`);
      const changed = (await readFile(path, 'utf8').catch(() => '')) !== nativeHelperPlist(env);
      const before = await run(['print', target]).catch(() => ({ stdout: '' }));
      if (changed && before.stdout) await run(['bootout', target]);
      await writeFile(path, nativeHelperPlist(env), { mode: 0o600 });
      await rm(resolve(home, 'Library/Application Support/Beeline/bin/supervise-helper'), {
        force: true,
      });
      await run(['enable', target]);
      if (changed || !before.stdout) await run(['bootstrap', domain, path]);
      else await run(['kickstart', ...(options.restart ? ['-k'] : []), target]);
      if (options.legacyCaller) await retire();
      // A PID alone is no readiness assertion; the caller awaits local control.
      const state = await run(['print', target]);
      return Number(state.stdout.match(/^\s*pid\s*=\s*(\d+)$/m)?.[1] ?? '0');
    },
    Math.max(0, (options.deadlineAt ?? Date.now() + 600_000) - Date.now()),
  );
}

/** Local observation only. A native active state is separate from per-agent readiness. */
export async function nativeHelperStatus(
  env: NodeJS.ProcessEnv = process.env,
): Promise<Record<string, string>> {
  try {
    const kind = nativeSupervisor(env);
    const args =
      kind === 'systemd'
        ? [
            '--user',
            'show',
            '--property=ActiveState',
            '--property=UnitFileState',
            '--property=MainPID',
            '--property=Result',
            SYSTEMD_HELPER_UNIT_NAME,
          ]
        : ['print', `gui/${process.getuid!()}/${LAUNCHD_HELPER_LABEL}`];
    const result = await exec(kind === 'systemd' ? 'systemctl' : 'launchctl', args, {
      env,
      encoding: 'utf8',
      timeout: 2000,
    });
    if (kind === 'systemd')
      return Object.fromEntries(
        result.stdout
          .trim()
          .split('\n')
          .map((line) => line.split('=', 2)),
      );
    return {
      state: result.stdout.match(/^\s*state\s*=\s*(.+)$/m)?.[1] ?? 'loaded',
      pid: result.stdout.match(/^\s*pid\s*=\s*(\d+)$/m)?.[1] ?? '0',
    };
  } catch (error) {
    return { state: 'unavailable', error: String(error) };
  }
}
