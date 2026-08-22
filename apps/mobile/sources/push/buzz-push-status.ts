import type { BuzzPushRegistrationPhase, BuzzPushRegistrationState } from './buzz-push-registration';

/**
 * Pure presentation rules for the settings push row: the switch reflects whether
 * a device token is actually registered with the gateway, not merely what the
 * user requested, and failures surface as an explicit status line instead of
 * the UI silently reading "on".
 */

/** Human-readable detail for a failure phase; null for non-failure phases. */
export function buzzPushPhaseDetail(phase: BuzzPushRegistrationPhase): string | null {
  switch (phase) {
    case 'permission-denied':
      return 'notification permission not granted';
    case 'token-type-unexpected':
      return 'device returned no usable token';
    case 'token-timed-out':
      return 'device token timed out';
    case 'token-failed':
      return 'device token unavailable';
    case 'registration-timed-out':
      return 'registration request timed out';
    case 'gateway-rejected':
      return 'push gateway refused registration';
    case 'network-failed':
      return 'network error reaching the push gateway';
    case 'registered':
    case 'disabled':
    case 'unsupported-platform':
      return null;
  }
}

/**
 * The switch is ON only when the user asked for push AND the last known
 * registration state agrees a device token is bound. No state yet (iOS/web,
 * or a pre-upgrade install that has not attempted) falls back to the stored
 * preference so nothing regresses.
 */
export function pushSwitchValue(
  enabled: boolean | null,
  state: BuzzPushRegistrationState | null,
): boolean {
  if (!(enabled ?? false)) return false;
  if (!state) return true;
  // Platforms without this registration path (iOS/web) keep the preference.
  return state.registered || state.phase === 'unsupported-platform';
}

/**
 * Full subtitle for the push row. Extends the existing OS-permission statuses
 * with an explicit registration-failure line naming the broken hop.
 */
export function pushStatusLabel(
  osPermissionLabel: string,
  enabled: boolean | null,
  state: BuzzPushRegistrationState | null,
): string {
  if (enabled === null) return osPermissionLabel;
  if (!enabled) return 'Off';
  if (state && !state.registered) {
    const detail = buzzPushPhaseDetail(state.phase);
    if (detail) {
      return state.retryable ? `${detail} — will retry` : detail;
    }
  }
  return osPermissionLabel;
}
