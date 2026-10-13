import { afterEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({
  native: { getPending: vi.fn(), acknowledge: vi.fn(), setReleaseContext: vi.fn() },
  module: true, os: 'android', active: 'active', onState: () => {}, onIdentity: () => {},
  remove: vi.fn(), unsubscribe: vi.fn(), report: vi.fn(),
}));
vi.mock('react-native', () => ({
  Platform: { get OS() { return state.os; } },
  AppState: { get currentState() { return state.active; }, addEventListener: (_event: string, fn: () => void) => {
    state.onState = fn; return { remove: state.remove };
  } },
}));
vi.mock('expo-modules-core', () => ({ requireOptionalNativeModule: () => state.module ? state.native : null }));
vi.mock('@/auth/monolith-session', () => ({ monolithSession: { subscribeIdentityChange: (fn: () => void) => {
  state.onIdentity = fn; return state.unsubscribe;
} } }));
vi.mock('@/sync/appConfig', () => ({ loadAppConfig: () => ({ releaseSha: 'current-release' }) }));
vi.mock('expo-updates', () => ({ runtimeVersion: '35', updateId: 'current-update' }));
vi.mock('./client-error-report', () => ({ reportNativeCrash: state.report }));
import { startNativeCrashReporting } from './native-crash-reporting';
const receipt = { id: 'native-fixture', message: 'java.lang.IllegalStateException: fatal', stack: 'at AudioSwitch', releaseSha: 'crashed-release' };
const stops: Array<() => void> = [];
function start() { const stop = startNativeCrashReporting(); stops.push(stop); return stop; }
afterEach(() => { stops.splice(0).forEach(stop => stop()); vi.clearAllMocks(); state.module = true; state.os = 'android'; state.active = 'active'; });

it('sends the crashed release metadata and clears only after server acceptance', async () => {
  state.native.getPending.mockResolvedValue(JSON.stringify(receipt)); state.report.mockResolvedValue(true);
  start();
  await vi.waitFor(() => expect(state.native.acknowledge).toHaveBeenCalledWith(receipt.id));
  expect(state.report).toHaveBeenCalledWith(receipt);
  expect(state.native.setReleaseContext).toHaveBeenCalledWith('current-release', '35', 'current-update');
});
it('keeps the receipt offline and retries after sign-in and foreground resume', async () => {
  state.native.getPending.mockResolvedValue(JSON.stringify(receipt)); state.report.mockResolvedValue(false);
  start();
  await vi.waitFor(() => expect(state.report).toHaveBeenCalledTimes(1));
  expect(state.native.acknowledge).not.toHaveBeenCalled();
  state.onIdentity();
  await vi.waitFor(() => expect(state.report).toHaveBeenCalledTimes(2));
  state.report.mockResolvedValue(true); state.onState();
  await vi.waitFor(() => expect(state.native.acknowledge).toHaveBeenCalledTimes(1));
});
it('deduplicates overlapping launch and identity callbacks and removes listeners', async () => {
  let resolve!: (value: string | null) => void;
  state.native.getPending.mockReturnValue(new Promise<string | null>(r => { resolve = r; }));
  const stop = start(); state.onIdentity(); state.onState();
  expect(state.native.getPending).toHaveBeenCalledTimes(1);
  stop(); resolve(JSON.stringify(receipt));
  await new Promise(r => setTimeout(r, 0));
  expect(state.report).not.toHaveBeenCalled(); expect(state.remove).toHaveBeenCalled(); expect(state.unsubscribe).toHaveBeenCalled();
});
it('is harmless on old binaries and other platforms', () => {
  state.module = false; start(); state.os = 'ios'; start();
  expect(state.native.getPending).not.toHaveBeenCalled();
});

it('retries when sign-in completes during an unauthenticated attempt', async () => {
  let finish!: (accepted: boolean) => void;
  state.native.getPending.mockResolvedValue(JSON.stringify(receipt));
  state.report.mockReturnValueOnce(new Promise<boolean>(r => { finish = r; })).mockResolvedValue(true);
  start();
  await vi.waitFor(() => expect(state.report).toHaveBeenCalledTimes(1));
  state.onIdentity(); finish(false);
  await vi.waitFor(() => expect(state.native.acknowledge).toHaveBeenCalledWith(receipt.id));
  expect(state.report).toHaveBeenCalledTimes(2);
});
