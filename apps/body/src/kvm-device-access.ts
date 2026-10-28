import { spawnSync } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';

/** A mount cannot override the device's host ACL. Never try other devices or sudo. */
export function prepareGrantedKvmAccess(devices: readonly string[], dependencies = {
  uid: () => process.getuid?.(),
  probe: () => { const fd = openSync('/dev/kvm', 'r+'); closeSync(fd); },
  acl: (uid: number) => {
    const result = spawnSync('setfacl', ['-m', `u:${uid}:rw`, '/dev/kvm'], { encoding: 'utf8', timeout: 5_000 });
    if (result.error || result.status !== 0) throw new Error(result.error?.message ?? result.stderr.trim());
  },
}): string | undefined {
  if (!devices.includes('/dev/kvm')) return;
  try { dependencies.probe(); return; } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EACCES')
      return `/dev/kvm is unavailable: ${error instanceof Error ? error.message : String(error)}`;
  }
  const uid = dependencies.uid();
  if (uid === undefined || !Number.isSafeInteger(uid) || uid < 0)
    return '/dev/kvm permission denied; cannot determine the helper host user';
  try {
    dependencies.acl(uid);
    dependencies.probe();
    return;
  } catch {
    return `/dev/kvm permission denied for helper uid ${uid}. An approved device grant mounts the node but cannot bypass its host ACL. Ask the host administrator to grant this helper user read/write access on the host (see docs/android-kvm-access.md), then retry.`;
  }
}
