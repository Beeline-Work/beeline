import { spawnSync } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';

/**
 * What this session can do with `/dev/kvm`. `advice` is the one line the agent
 * reads in its prompt; `unavailable` (no device on this host) carries none.
 */
export type KvmAccess =
  | { readonly status: 'works' }
  | { readonly status: 'unavailable'; readonly detail: string }
  | { readonly status: 'needs-grant'; readonly advice: string }
  | { readonly status: 'host-denied'; readonly advice: string };

const NEEDS_GRANT =
  '/dev/kvm is present but this session cannot open it. To run an Android emulator, ask with request_grant(kind:device, target:"/dev/kvm", reason, purpose); an approved grant lets the helper open it next session.';

function hostDenied(uid: number | undefined): string {
  return uid === undefined
    ? 'Your /dev/kvm grant is approved, but the host blocks this helper user and its uid is unknown. Ask the host admin to grant the helper user rw on /dev/kvm (docs/android-kvm-access.md); another grant will not help.'
    : `Your /dev/kvm grant is approved, but the host blocks helper uid ${uid}. Ask the host admin to run \`sudo setfacl -m u:${uid}:rw /dev/kvm\` (docs/android-kvm-access.md); another grant will not help.`;
}

/**
 * Probes `/dev/kvm` for this helper user. Only an approved grant attempts the
 * exact user ACL; a mount cannot override the device's host ACL. Never try
 * other devices or sudo.
 */
export function prepareKvmAccess(devices: readonly string[], dependencies = {
  uid: () => process.getuid?.(),
  probe: () => { const fd = openSync('/dev/kvm', 'r+'); closeSync(fd); },
  acl: (uid: number) => {
    const result = spawnSync('setfacl', ['-m', `u:${uid}:rw`, '/dev/kvm'], { encoding: 'utf8', timeout: 5_000 });
    if (result.error || result.status !== 0) throw new Error(result.error?.message ?? result.stderr.trim());
  },
}): KvmAccess {
  try { dependencies.probe(); return { status: 'works' }; } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EACCES')
      return { status: 'unavailable', detail: error instanceof Error ? error.message : String(error) };
  }
  if (!devices.includes('/dev/kvm')) return { status: 'needs-grant', advice: NEEDS_GRANT };
  const raw = dependencies.uid();
  const uid = raw !== undefined && Number.isSafeInteger(raw) && raw >= 0 ? raw : undefined;
  if (uid === undefined) return { status: 'host-denied', advice: hostDenied(undefined) };
  try {
    dependencies.acl(uid);
    dependencies.probe();
    return { status: 'works' };
  } catch {
    return { status: 'host-denied', advice: hostDenied(uid) };
  }
}
