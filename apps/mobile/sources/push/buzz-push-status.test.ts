import { describe, expect, it } from 'vitest';

import type { BuzzPushRegistrationState } from './buzz-push-registration';
import { buzzPushPhaseDetail, pushStatusLabel, pushSwitchValue } from './buzz-push-status';

function state(overrides: Partial<BuzzPushRegistrationState> = {}): BuzzPushRegistrationState {
  return {
    registered: false,
    retryable: true,
    phase: 'token-timed-out',
    failedAttempts: 1,
    updatedAt: 0,
    ...overrides,
  };
}

describe('push status presentation', () => {
  it('keeps the switch on only for a truthfully registered token', () => {
    expect(pushSwitchValue(true, state({ registered: true, phase: 'registered' }))).toBe(true);
    // A failed or unknown registration turns the requested-on preference off.
    expect(pushSwitchValue(true, state())).toBe(false);
    expect(pushSwitchValue(true, null)).toBe(true);
    expect(pushSwitchValue(false, state({ registered: true, phase: 'registered' }))).toBe(false);
    expect(pushSwitchValue(null, null)).toBe(false);
    // Platforms without this registration path keep the preference.
    expect(
      pushSwitchValue(true, state({ phase: 'unsupported-platform', retryable: false })),
    ).toBe(true);
  });

  it('surfaces each failure phase as a named, honest status', () => {
    expect(pushStatusLabel('OS permission: allowed', true, state())).toBe(
      'device token timed out — will retry',
    );
    expect(
      pushStatusLabel(
        'OS permission: allowed',
        true,
        state({ phase: 'gateway-rejected' }),
      ),
    ).toBe('push gateway refused registration — will retry');
    expect(
      pushStatusLabel(
        'OS permission: allowed',
        true,
        state({ phase: 'permission-denied', retryable: false }),
      ),
    ).toBe('notification permission not granted');
    expect(
      pushStatusLabel(
        'OS permission: blocked in device settings',
        true,
        state({ phase: 'network-failed', message: 'offline' }),
      ),
    ).toBe('network error reaching the push gateway — will retry');
  });

  it('falls back to the OS permission label when enabled and registered', () => {
    expect(
      pushStatusLabel(
        'OS permission: allowed',
        true,
        state({ registered: true, retryable: false, phase: 'registered' }),
      ),
    ).toBe('OS permission: allowed');
    expect(pushStatusLabel('OS permission: allowed', true, null)).toBe('OS permission: allowed');
  });

  it('shows Off when disabled and never a stale failure line', () => {
    expect(pushStatusLabel('OS permission: allowed', false, state())).toBe('Off');
  });

  it('keeps the checking state while the preference has not loaded', () => {
    expect(pushStatusLabel('Checking OS permission', null, null)).toBe('Checking OS permission');
  });

  it('maps only failure phases to a detail line', () => {
    expect(buzzPushPhaseDetail('registered')).toBeNull();
    expect(buzzPushPhaseDetail('disabled')).toBeNull();
    expect(buzzPushPhaseDetail('unsupported-platform')).toBeNull();
    expect(buzzPushPhaseDetail('token-timed-out')).not.toBeNull();
  });
});
