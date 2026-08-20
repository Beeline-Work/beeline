/** Production relay defaults shared by shipped Beeline clients. */
export const DEFAULT_RELAY_HOST = 'usebeeline.app';
/** Permanent compatibility alias used by already-shipped clients and stored runtimes. */
export const LEGACY_RELAY_HOST = 'relay.buzzrouter.com';
export const DEFAULT_RELAY_SCHEME = 'https';
export const DEFAULT_RELAY_BASE_URL = `${DEFAULT_RELAY_SCHEME}://${DEFAULT_RELAY_HOST}`;
export const DEFAULT_RELAY_WS_URL = `wss://${DEFAULT_RELAY_HOST}`;

export const PRODUCTION_RELAY_HOSTS = [DEFAULT_RELAY_HOST, LEGACY_RELAY_HOST] as const;

export function isProductionRelayHost(host: string): boolean {
  return (PRODUCTION_RELAY_HOSTS as readonly string[]).includes(host.toLowerCase());
}
