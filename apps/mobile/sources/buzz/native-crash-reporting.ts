import { AppState, Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo-modules-core';
import { monolithSession } from '@/auth/monolith-session';
import { loadAppConfig } from '@/sync/appConfig';
import * as Updates from 'expo-updates';
import { reportNativeCrash, type NativeCrashReport } from './client-error-report';

type CrashTrace = {
  getPending(): Promise<string | null>;
  acknowledge(id: string): Promise<void>;
  setReleaseContext(sha: string, runtime: string, update: string): void;
};

/** Older Android binaries and other platforms have no module and remain OTA compatible. */
export function startNativeCrashReporting(): () => void {
  if (Platform.OS !== 'android') return () => {};
  const native = requireOptionalNativeModule<CrashTrace>('AndroidCrashTrace');
  if (!native) return () => {};
  const config = loadAppConfig();
  native.setReleaseContext(config.releaseSha ?? config.buildCommitSha ?? '', Updates.runtimeVersion ?? '', Updates.updateId ?? '');
  let active = true;
  let sending = false;
  let requested = false;
  const send = () => {
    if (!active || AppState.currentState !== 'active') return;
    if (sending) { requested = true; return; }
    sending = true;
    void (async () => {
      const value = await native.getPending();
      if (!value || !active) return;
      const report = JSON.parse(value) as NativeCrashReport;
      if (await reportNativeCrash(report)) await native.acknowledge(report.id);
    })().catch(() => {}).finally(() => {
      sending = false;
      if (requested) { requested = false; send(); }
    });
  };
  const state = AppState.addEventListener('change', send);
  const identity = monolithSession.subscribeIdentityChange(send);
  send();
  return () => { active = false; state.remove(); identity(); };
}
