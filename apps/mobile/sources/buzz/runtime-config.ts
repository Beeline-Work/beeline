import { loadAppConfig } from '@/sync/appConfig';

const DEFAULT_RELAY_URL = 'https://usebeeline.app';
const DEFAULT_PUSH_GATEWAY_URL = 'https://usebeeline.app/push';
const DEFAULT_MONOLITH_URL = 'https://beeline-server.fly.dev';

export interface BuzzRuntimeConfig {
  relayUrl: string;
  pushGatewayUrl: string;
  monolithUrl: string;
  monolithEnabled: boolean;
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
    monolithUrl: normalizedUrl(config.buzzyMonolithUrl, DEFAULT_MONOLITH_URL),
    monolithEnabled: config.buzzyMonolithEnabled === true,
  };
}
