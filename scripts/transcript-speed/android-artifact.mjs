import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
export function androidArtifact(adb) {
  const path = process.env.TRANSCRIPT_APK ?? 'apps/mobile/android/app/build/outputs/apk/release/app-release.apk';
  const apkSha256 = createHash('sha256').update(readFileSync(path)).digest('hex');
  const installed = adb('shell', 'pm', 'path', 'app.usebeeline').trim().replace(/^package:/, '');
  if (!/^\/data\/app\/[A-Za-z0-9_=+./~-]+\/base\.apk$/.test(installed)) throw new Error('Expected one installed fixture APK');
  const installedSha256 = adb('shell', 'sha256sum', installed).trim().split(/\s/)[0];
  if (apkSha256 !== installedSha256) throw new Error('Installed APK differs from TRANSCRIPT_APK; refusing misleading build metadata');
  return { apkSha256, runtime: adb('shell', 'getprop', 'ro.build.fingerprint').trim(),
    refreshEvidence: adb('shell', 'dumpsys', 'display') };
}
