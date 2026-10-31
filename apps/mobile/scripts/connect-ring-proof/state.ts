import React from 'react';

export const ProofState = React.createContext(false);
export const useLocalSearchParams = () => ({
  workspaceId: 'local-proof', viewerId: 'local-viewer', connectorId: 'trusty-squire',
  pairedConnectorId: 'squire:proof', helperId: 'proof',
});
export const router = { back() {}, push() {}, replace() {} };
export const useIsDesktop = () => false;
export const useLatencyRouteFrame = () => {};
const retry = () => {};
export function useInstallObserver() {
  const failed = React.useContext(ProofState);
  const data = React.useMemo(() => ({
    connectorId: 'squire:proof', helperName: 'Squire', connected: false,
    steps: [{ label: 'Helper Squire reached', status: failed ? 'failed' : 'active',
      ...(failed ? { reason: 'Squire didn’t answer for 1 minute. Check it is on and online.' } : {}) }],
  }), [failed]);
  return { data, error: null, retry, installMissing: false };
}
export const useSharedWorkbench = () => ({ value: { helpers: [{ id: 'proof', name: 'Squire', online: true }] }, error: null });
export const getWorkbenchSource = () => ({ pairConnector: async () => ({ connectorId: 'squire:proof' }) });
export const monolithPhoneOperation = async () => { throw new Error('Local proof has no network'); };
