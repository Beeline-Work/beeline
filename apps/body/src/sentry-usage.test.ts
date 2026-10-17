import { expect, it, vi } from 'vitest';
const sdk = vi.hoisted(() => ({ captureException: vi.fn(), init: vi.fn() }));
vi.mock('@sentry/node', () => sdk);
import { captureHelperError } from './sentry.js';
import { runLeasedEmulator } from './android-emulator-lease.js';

it('Reproduction SENTRY-5: emulator missing -avd keeps the usage message without capture', async () => {
  const failure = await runLeasedEmulator([], {
    BEELINE_ANDROID_LEASE_ROOT: '/unused/leases', BEELINE_ANDROID_INSTANCE_ROOT: '/unused/instances',
    BEELINE_ANDROID_BASE_AVD_HOME: '/unused/avds', BEELINE_ANDROID_EMULATOR_BINARY: '/unused/emulator',
  }).catch(error => error);
  expect(failure).toBeInstanceOf(Error);
  expect(failure.message).toBe('emulator requires -avd <name>');
  captureHelperError(failure);
  expect(sdk.captureException).not.toHaveBeenCalled();
  const unexpected = new Error('emulator launch failed');
  captureHelperError(unexpected);
  expect(sdk.captureException).toHaveBeenCalledWith(unexpected, expect.anything());
});
