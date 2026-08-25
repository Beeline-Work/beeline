export type ManualUpdatePhase = 'idle' | 'checking' | 'downloading' | 'reloading';

export type ManualUpdateNotice = 'none' | 'latest' | 'error' | 'unavailable';

export type ManualUpdateState = {
  phase: ManualUpdatePhase;
  notice: ManualUpdateNotice;
};

export type ManualUpdateAction =
  | { type: 'start-check' }
  | { type: 'update-available' }
  | { type: 'update-downloaded' }
  | { type: 'latest' }
  | { type: 'failed' };

export function createManualUpdateState(updatesEnabled: boolean): ManualUpdateState {
  return {
    phase: 'idle',
    notice: updatesEnabled ? 'none' : 'unavailable',
  };
}

/**
 * The manual OTA control has one-way busy phases. Both a failed check and a
 * failed download return to idle so the user always has an immediate retry.
 */
export function manualUpdateReducer(
  state: ManualUpdateState,
  action: ManualUpdateAction,
): ManualUpdateState {
  switch (action.type) {
    case 'start-check':
      return state.phase === 'idle' && state.notice !== 'unavailable'
        ? { phase: 'checking', notice: 'none' }
        : state;
    case 'update-available':
      return state.phase === 'checking' ? { phase: 'downloading', notice: 'none' } : state;
    case 'update-downloaded':
      return state.phase === 'downloading' ? { phase: 'reloading', notice: 'none' } : state;
    case 'latest':
      return state.phase === 'checking' ? { phase: 'idle', notice: 'latest' } : state;
    case 'failed':
      return state.phase === 'idle' ? state : { phase: 'idle', notice: 'error' };
  }
}

export function isManualUpdateBusy(state: ManualUpdateState): boolean {
  return state.phase !== 'idle';
}

export function manualUpdateButtonLabel(state: ManualUpdateState): string {
  if (state.notice === 'unavailable') return 'Updates unavailable';
  if (state.phase === 'checking') return 'Checking…';
  if (state.phase === 'downloading') return 'Downloading…';
  if (state.phase === 'reloading') return 'Reloading…';
  return 'Check for update';
}

export function manualUpdateMessage(state: ManualUpdateState): string | null {
  if (state.notice === 'latest') return "You're on the latest version.";
  if (state.notice === 'error') {
    return "Couldn't check for updates. Check your connection and try again.";
  }
  if (state.notice === 'unavailable') return 'Updates are unavailable in this build.';
  return null;
}
