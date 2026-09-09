/** Defaults for the isolated local relay/tooling stack; phones use the Fly monolith. */
export const DEFAULT_RELAY_HOST = '127.0.0.1:3010';
export const DEFAULT_RELAY_SCHEME = 'http';
export const DEFAULT_RELAY_BASE_URL = `${DEFAULT_RELAY_SCHEME}://${DEFAULT_RELAY_HOST}`;
export const DEFAULT_RELAY_WS_URL = `ws://${DEFAULT_RELAY_HOST}`;

export const PRODUCTION_RELAY_HOSTS = [DEFAULT_RELAY_HOST] as const;

export function isProductionRelayHost(host: string): boolean {
  return (PRODUCTION_RELAY_HOSTS as readonly string[]).includes(host.toLowerCase());
}
