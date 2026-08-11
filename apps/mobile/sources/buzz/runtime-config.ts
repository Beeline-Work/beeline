import { loadAppConfig } from '@/sync/appConfig';

const DEFAULT_RELAY_URL = 'https://relay.buzzrouter.com';
const DEFAULT_PUSH_GATEWAY_URL = 'https://push.buzzrouter.com';

export interface BuzzRuntimeConfig {
  relayUrl: string;
  pushGatewayUrl: string;
}

function normalizedUrl(value: string | undefined, fallback: string): string {
  const candidate = value?.trim() || fallback;
  return candidate.replace(/\/$/, '');
}

/** Runtime config shared by the Buzz relay transport and push registration. */
export function getBuzzRuntimeConfig(): BuzzRuntimeConfig {
  const config = loadAppConfig();
  return {
    relayUrl: normalizedUrl(config.buzzyRelayUrl, DEFAULT_RELAY_URL),
    pushGatewayUrl: normalizedUrl(config.buzzyPushGatewayUrl, DEFAULT_PUSH_GATEWAY_URL),
  };
}
