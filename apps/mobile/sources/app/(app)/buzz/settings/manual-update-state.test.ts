import { describe, expect, it } from 'vitest';

import {
  createManualUpdateState,
  isManualUpdateBusy,
  manualUpdateButtonLabel,
  manualUpdateMessage,
  manualUpdateReducer,
  type ManualUpdateState,
} from './manual-update-state';

function reduce(
  state: ManualUpdateState,
  ...actions: Parameters<typeof manualUpdateReducer>[1][]
): ManualUpdateState {
  return actions.reduce(manualUpdateReducer, state);
}

describe('manual OTA update state', () => {
  it('moves through check, download, and reload in order', () => {
    const checking = manualUpdateReducer(createManualUpdateState(true), { type: 'start-check' });
    expect(checking).toEqual({ phase: 'checking', notice: 'none' });
    expect(isManualUpdateBusy(checking)).toBe(true);
    expect(manualUpdateButtonLabel(checking)).toBe('Checking…');

    const downloading = manualUpdateReducer(checking, { type: 'update-available' });
    expect(downloading).toEqual({ phase: 'downloading', notice: 'none' });
    expect(manualUpdateButtonLabel(downloading)).toBe('Downloading…');

    const reloading = manualUpdateReducer(downloading, { type: 'update-downloaded' });
    expect(reloading).toEqual({ phase: 'reloading', notice: 'none' });
    expect(manualUpdateButtonLabel(reloading)).toBe('Reloading…');
  });

  it('returns to retryable idle when the running version is latest', () => {
    const state = reduce(
      createManualUpdateState(true),
      { type: 'start-check' },
      { type: 'latest' },
    );

    expect(state).toEqual({ phase: 'idle', notice: 'latest' });
    expect(isManualUpdateBusy(state)).toBe(false);
    expect(manualUpdateButtonLabel(state)).toBe('Check for update');
    expect(manualUpdateMessage(state)).toBe("You're on the latest version.");
  });

  it.each(['checking', 'downloading', 'reloading'] as const)(
    'returns a failed %s operation to retryable idle',
    (phase) => {
      const state = manualUpdateReducer({ phase, notice: 'none' }, { type: 'failed' });

      expect(state).toEqual({ phase: 'idle', notice: 'error' });
      expect(isManualUpdateBusy(state)).toBe(false);
      expect(manualUpdateMessage(state)).toContain('try again');
    },
  );

  it('keeps the control idle and unavailable when expo-updates is disabled', () => {
    const unavailable = createManualUpdateState(false);

    expect(unavailable).toEqual({ phase: 'idle', notice: 'unavailable' });
    expect(manualUpdateButtonLabel(unavailable)).toBe('Updates unavailable');
    expect(manualUpdateMessage(unavailable)).toBe('Updates are unavailable in this build.');
    expect(manualUpdateReducer(unavailable, { type: 'start-check' })).toBe(unavailable);
  });

  it('ignores out-of-order events', () => {
    const idle = createManualUpdateState(true);

    expect(manualUpdateReducer(idle, { type: 'update-available' })).toBe(idle);
    expect(manualUpdateReducer(idle, { type: 'update-downloaded' })).toBe(idle);
    expect(manualUpdateReducer(idle, { type: 'latest' })).toBe(idle);
  });
});
