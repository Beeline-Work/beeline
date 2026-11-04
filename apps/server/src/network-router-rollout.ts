import { serverSetting } from './server-configuration.js';
/** Router admission is on for every deployment by default. The explicit zero
 * remains available for rollback; protocol support and current authority are
 * still negotiated, and a selected operation never falls back on failure. */
export const networkRouterEnabled = (): boolean => serverSetting('BEELINE_NETWORK_ROUTER_V1') !== '0';
