import * as net from 'node:net';

export const NETWORK_FAMILY_ATTEMPT_TIMEOUT_MS = 5_000;

interface NetworkFamilyDefaults {
  setDefaultAutoSelectFamilyAttemptTimeout?: (value: number) => void;
  setDefaultAutoSelectFamily?: (value: boolean) => void;
}

export function configureNetworkFamilyDefaults(
  network: NetworkFamilyDefaults = net,
): 'timeout' | 'autoselection-disabled' {
  if (typeof network.setDefaultAutoSelectFamilyAttemptTimeout === 'function') {
    // Avoid AggregateError [ETIMEDOUT] after an immediate IPv6 ENETUNREACH leaves IPv4 only 250ms.
    network.setDefaultAutoSelectFamilyAttemptTimeout(NETWORK_FAMILY_ATTEMPT_TIMEOUT_MS);
    return 'timeout';
  }

  network.setDefaultAutoSelectFamily?.(false);
  return 'autoselection-disabled';
}

configureNetworkFamilyDefaults();
