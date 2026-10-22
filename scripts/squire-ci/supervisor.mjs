#!/usr/bin/env node
// Run as the operator, never as the untrusted CI user. No App key is copied.
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';

const gh = process.env.SQUIRE_CI_GH;
const proving = process.argv.includes('--prove');
if (!gh && !proving) throw new Error('SQUIRE_CI_GH must name the corner GitHub launcher');
let stopping = false;
const children = new Set();
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
  stopping = true;
  try {
    execFileSync('/usr/bin/sudo', ['-n', '/usr/bin/systemctl', 'stop',
      'beeline-ci-1', 'beeline-ci-2', 'beeline-ci-3', 'beeline-ci-4'], { stdio: 'ignore' });
  } catch { /* Absent units are already stopped. */ }
  for (const child of children) child.kill('SIGTERM');
});

async function slot(index) {
  while (!stopping) {
    const name = `squire-ci-${index}-${randomUUID()}`;
    try {
      const token = proving ? '' : JSON.parse(execFileSync(gh, ['api', '--method', 'POST',
        'repos/Beeline-Work/beeline/actions/runners/registration-token'],
      { encoding: 'utf8', timeout: 60000 })).token;
      if (!token && !proving) throw new Error('GitHub supplied no registration token');
      const args = ['-n', 'systemd-run', '--quiet', '--wait', '--pipe',
        `--unit=${proving ? `beeline-ci-proof-${randomUUID()}` : `beeline-ci-${index}`}`, '--collect',
        '-p', 'User=beeline-ci', '-p', 'Group=beeline-ci',
        '-p', `RuntimeDirectory=beeline-ci-${index}`, '-p', 'RuntimeDirectoryMode=0700',
        '-p', 'CPUQuota=150%', '-p', 'MemoryMax=6G', '-p', 'MemorySwapMax=0',
        '-p', 'TasksMax=512', '-p', 'RuntimeMaxSec=45min',
        '-p', 'ProtectSystem=strict', '-p', 'ProtectHome=yes',
        '-p', 'PrivateTmp=yes', '-p', 'PrivateDevices=yes',
        '-p', 'NoNewPrivileges=yes', '-p', 'RestrictSUIDSGID=yes',
        '-p', 'ProtectKernelTunables=yes', '-p', 'ProtectKernelModules=yes',
        '-p', 'ProtectControlGroups=yes', '-p', 'ProtectProc=invisible',
        '-p', 'CapabilityBoundingSet=', '-p', 'UMask=0077',
        '-p', 'InaccessiblePaths=-/opt -/var/lib -/run/user -/run/docker.sock -/run/containerd -/run/dbus -/run/systemd/private',
        `/usr/local/lib/beeline-ci/${proving ? 'verify-isolation.sh' : 'run-once.sh'}`, name];
      const child = spawn('/usr/bin/sudo', args, { stdio: ['pipe', 'inherit', 'inherit'] });
      children.add(child);
      child.stdin.on('error', () => {});
      child.stdin.end(`${token}\n`);
      const code = await new Promise((resolve, reject) => {
        child.on('error', reject);
        child.on('exit', resolve);
      });
      children.delete(child);
      if (proving) {
        if (code !== 0) process.exitCode = 1;
        return;
      }
      if (code !== 0) console.error(`Slot ${index}: unit exited ${code}`);
    } catch (error) {
      // Do not log subprocess buffers: registration responses contain secrets.
      console.error(`Slot ${index}: runner launch failed (${error.code ?? 'error'})`);
    }
    // Remove timed-out/offline registrations as well as normally ephemeral ones.
    try {
      const runners = JSON.parse(execFileSync(gh, ['api',
        'repos/Beeline-Work/beeline/actions/runners'], { encoding: 'utf8', timeout: 60000 })).runners;
      const runner = runners.find((candidate) => candidate.name === name);
      if (runner) execFileSync(gh, ['api', '--method', 'DELETE',
        `repos/Beeline-Work/beeline/actions/runners/${runner.id}`], { timeout: 60000, stdio: 'ignore' });
    } catch { console.error(`Slot ${index}: registration cleanup needs checking`); }
    if (!stopping) await setTimeout(10000);
  }
}
await Promise.all((proving ? [1] : [1, 2, 3, 4]).map(slot));
